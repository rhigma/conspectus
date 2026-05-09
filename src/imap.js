import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query, queryOne } from './db.js';
import { speichereAnhang } from './nextcloud.js';
import { diktatVerarbeiten, getPlaudAbsenderPattern, cleanPlaudBody } from './diktate.js';

const MAX_EMAILS = 200;
const VORGAENGE_ROOT = 'Vorgänge';

function createClient(account) {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: !!account.tls,
    auth: { user: account.username, pass: account.password },
    logger: false,
    socketTimeout: 20000,
    connectionTimeout: 15000,
    disableAutoIdle: true,
  });
  client.on('error', () => {});
  return client;
}

export function sanitizeFolderName(titel) {
  return titel
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

export function vorgangFolderPath(titel) {
  return `${VORGAENGE_ROOT}/${sanitizeFolderName(titel)}`;
}

export async function syncAllAccounts() {
  const accounts = await query('SELECT * FROM email_accounts WHERE active = 1');

  const results = await Promise.all(accounts.map(async acc => {
    const start = Date.now();
    try {
      const count = await syncAccount(acc);
      await syncVorgangFolders(acc).catch(e =>
        console.error(`[IMAP] Vorgang-Ordner (${acc.email}):`, e.message)
      );
      await query(
        'INSERT INTO sync_log (type, status, message, duration_ms) VALUES (?,?,?,?)',
        ['email', 'ok', `${acc.email}: ${count} neue`, Date.now() - start]
      );
      return { account: acc.label, status: 'ok', new: count };
    } catch (err) {
      await query(
        'INSERT INTO sync_log (type, status, message, duration_ms) VALUES (?,?,?,?)',
        ['email', 'error', `${acc.email}: ${err.message}`, Date.now() - start]
      );
      return { account: acc.label, status: 'error', error: err.message };
    }
  }));

  // IMAP-Konten aus .env einmalig importieren wenn noch keine vorhanden
  await importEnvAccounts();

  return results;
}

async function importEnvAccounts() {
  if (!process.env.IMAP_ACCOUNTS) return;
  try {
    const list = JSON.parse(process.env.IMAP_ACCOUNTS);
    for (const acc of list) {
      const exists = await queryOne('SELECT id FROM email_accounts WHERE email = ?', [acc.email]);
      if (!exists) {
        await query(
          'INSERT INTO email_accounts (label, email, host, port, username, password, tls, color) VALUES (?,?,?,?,?,?,?,?)',
          [acc.label, acc.email, acc.host, acc.port || 993, acc.username, acc.password, acc.tls ? 1 : 0, acc.color || '#d4a853']
        );
        console.log('[IMAP] Konto importiert:', acc.email);
      }
    }
  } catch (e) {
    console.warn('[IMAP] ENV-Import Fehler:', e.message);
  }
}

async function syncAccount(account) {
  const client = createClient(account);

  await client.connect();
  let newCount = 0;

  // Plaud-Absender-Pattern einmal pro Sync laden — billiger als pro E-Mail.
  const plaudPattern = (await getPlaudAbsenderPattern()).toLowerCase();

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      if (total === 0) return 0;
      const from = Math.max(1, total - MAX_EMAILS + 1);

      // Pass 1: Envelopes – neue UIDs ermitteln, \Answered-Flag prüfen
      // Alle bekannten UIDs für dieses Konto vorab laden (1 DB-Query statt N)
      const knownRows = await query(
        'SELECT id, uid, erledigt FROM emails WHERE account_id = ?',
        [account.id]
      );
      const knownByUid = new Map(knownRows.map(r => [r.uid, r]));

      const neueMsgs = [];
      const answeredUpdates = [];
      for await (const msg of client.fetch(`${from}:${total}`, {
        uid: true, flags: true, envelope: true,
      })) {
        const existing = knownByUid.get(String(msg.uid));
        if (!existing) {
          neueMsgs.push({ uid: msg.uid, flags: msg.flags, envelope: msg.envelope });
        } else if (!existing.erledigt && msg.flags.has('\\Answered')) {
          answeredUpdates.push(existing.id);
        }
      }
      for (const id of answeredUpdates) {
        await query('UPDATE emails SET erledigt = 1 WHERE id = ?', [id]);
      }

      // Pass 2: Body + Anhänge nur für neue E-Mails laden
      // (client.download() innerhalb des fetch-Loops ist unzuverlässig,
      // da die IMAP-Verbindung durch den laufenden FETCH belegt ist)
      for (const msg of neueMsgs) {
        let bodyText = '';
        let anhangPfade = [];
        try {
          for await (const full of client.fetch(
            { uid: `${msg.uid}:${msg.uid}` },
            { source: true },
            { uid: true }
          )) {
            const parsed = await simpleParser(full.source);
            bodyText = (parsed.text || '').slice(0, 5000);
            if (!bodyText && parsed.html) {
              bodyText = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
            }
            for (const att of parsed.attachments || []) {
              if (att.size > 20 * 1024 * 1024) continue;
              try {
                const pfad = await speichereAnhang(
                  '/E-Mail-Anhänge',
                  `${msg.uid}_${att.filename || 'anhang'}`,
                  att.content,
                  att.contentType
                );
                anhangPfade.push({ name: att.filename, pfad, typ: att.contentType, groesse: att.size });
              } catch (e) { /* Anhang-Fehler ignorieren */ }
            }
          }
        } catch (e) { /* Body optional */ }

        const env = msg.envelope;
        const fromEmail = (env.from?.[0]?.address || '').toLowerCase();

        // Plaud-Diktat per E-Mail: vor dem regulären INSERT abfangen.
        // Bei Erfolg wandert die Mail in den IMAP-"Erledigt"-Ordner, kein DB-Insert.
        if (plaudPattern && fromEmail.includes(plaudPattern)) {
          const transkript = cleanPlaudBody(bodyText);
          if (transkript) {
            try {
              await diktatVerarbeiten({
                titel: env.subject || 'Diktat ohne Betreff',
                transkript,
                aufgenommenAm: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
                quelle: 'plaud_email',
              });
              try { await client.mailboxCreate('Erledigt'); } catch (e) { /* exists */ }
              try {
                await client.messageMove({ uid: `${msg.uid}:${msg.uid}` }, 'Erledigt', { uid: true });
              } catch (e) {
                console.warn('[Diktat-Mail] Move fehlgeschlagen:', e.message);
              }
              console.log(`[Diktat-Mail] "${env.subject}" → als Diktat verarbeitet`);
              continue;
            } catch (e) {
              console.error('[Diktat-Mail] Verarbeitung fehlgeschlagen, falle auf reguläre Mail-Behandlung zurück:', e.message);
              // Fall-through: lieber als E-Mail behalten als verlieren.
            }
          } else {
            console.warn(`[Diktat-Mail] Leerer Body bei "${env.subject}" — als reguläre E-Mail behalten`);
          }
        }

        await query(
          `INSERT IGNORE INTO emails
            (account_id, uid, message_id, from_name, from_email, subject, body_text, date, unread, anhang_pfade, imap_mailbox)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            account.id, String(msg.uid),
            env.messageId || null,
            env.from?.[0]?.name || null,
            env.from?.[0]?.address || null,
            env.subject || '(kein Betreff)',
            bodyText,
            env.date || null,
            msg.flags.has('\\Seen') ? 0 : 1,
            JSON.stringify(anhangPfade),
            'INBOX',
          ]
        );
        newCount++;
      }
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (e) {}
  }

  return newCount;
}

async function syncVorgangFolders(account) {
  const client = createClient(account);
  await client.connect();

  try {
    let allFolders;
    try {
      allFolders = await client.list();
    } catch (e) {
      return;
    }

    const vorgangFolders = allFolders.filter(f =>
      f.path.startsWith(VORGAENGE_ROOT + '/') && f.path !== VORGAENGE_ROOT
    );

    for (const folder of vorgangFolders) {
      const folderPath = folder.path;

      // Zugehörigen Vorgang in DB finden oder neu anlegen
      let vorgang = await queryOne(
        'SELECT id, titel FROM vorgaenge WHERE imap_folder = ?',
        [folderPath]
      );
      if (!vorgang) {
        const folderName = folderPath.slice(VORGAENGE_ROOT.length + 1);
        const result = await query(
          'INSERT INTO vorgaenge (titel, imap_folder) VALUES (?,?)',
          [folderName, folderPath]
        );
        vorgang = { id: result.insertId, titel: folderName };
        console.log(`[IMAP] Neuer Vorgang aus Ordner angelegt: ${folderName}`);
      }

      let lock;
      try {
        lock = await client.getMailboxLock(folderPath);
      } catch (e) {
        continue;
      }

      try {
        if (client.mailbox.exists === 0) continue;

        const allUids = await client.search({ all: true }, { uid: true });

        // Bekannte UIDs in diesem Ordner
        const knownRows = await query(
          'SELECT uid FROM emails WHERE account_id = ? AND imap_mailbox = ?',
          [account.id, folderPath]
        );
        const knownUidSet = new Set(knownRows.map(r => String(r.uid)));

        const newUids = allUids.filter(uid => !knownUidSet.has(String(uid)));
        if (!newUids.length) continue;

        for (const uid of newUids) {
          let msgInfo = null;
          try {
            for await (const msg of client.fetch(
              { uid: `${uid}:${uid}` },
              { uid: true, envelope: true, flags: true, source: true },
              { uid: true }
            )) {
              msgInfo = msg;
            }
          } catch (e) { continue; }
          if (!msgInfo) continue;

          const messageId = msgInfo.envelope?.messageId || null;

          // Bereits in DB per message_id? (z.B. manuell aus INBOX verschoben)
          const existing = messageId ? await queryOne(
            'SELECT id FROM emails WHERE account_id = ? AND message_id = ?',
            [account.id, messageId]
          ) : null;

          if (existing) {
            await query(
              'UPDATE emails SET uid = ?, imap_mailbox = ?, vorgang_id = ? WHERE id = ?',
              [String(uid), folderPath, vorgang.id, existing.id]
            );
          } else {
            const parsed = await simpleParser(msgInfo.source).catch(() => ({}));
            let bodyText = (parsed.text || '').slice(0, 5000);
            if (!bodyText && parsed.html) {
              bodyText = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
            }
            const env = msgInfo.envelope;
            await query(
              `INSERT INTO emails
                (account_id, uid, message_id, from_name, from_email, subject, body_text, date, unread, imap_mailbox, vorgang_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON DUPLICATE KEY UPDATE imap_mailbox = VALUES(imap_mailbox), vorgang_id = VALUES(vorgang_id)`,
              [
                account.id, String(uid), messageId,
                env.from?.[0]?.name || null,
                env.from?.[0]?.address || null,
                env.subject || '(kein Betreff)',
                bodyText,
                env.date || null,
                msgInfo.flags.has('\\Seen') ? 0 : 1,
                folderPath,
                vorgang.id,
              ]
            );
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    try { await client.logout(); } catch (e) {}
  }
}

// Verschiebt eine E-Mail in den IMAP-Vorgang-Ordner. Gibt die neue UID zurück (oder null).
export async function moveToVorgangFolder(account, sourceMailbox, uid, folderPath) {
  const client = createClient(account);
  await client.connect();
  try {
    try { await client.mailboxCreate(VORGAENGE_ROOT); } catch (e) {}
    try { await client.mailboxCreate(folderPath); } catch (e) {}
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      const result = await client.messageMove(
        { uid: `${uid}:${uid}` },
        folderPath,
        { uid: true }
      );
      const newUid = result?.uidMap?.get(parseInt(uid));
      return newUid ? String(newUid) : null;
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (e) {}
  }
}

// Benennt den Vorgang-Ordner auf allen aktiven IMAP-Konten um.
export async function renameVorgangFolderOnAllAccounts(oldPath, newPath) {
  const accounts = await query('SELECT * FROM email_accounts WHERE active = 1');
  for (const acc of accounts) {
    const client = createClient(acc);
    try {
      await client.connect();
      await client.mailboxRename(oldPath, newPath);
    } catch (e) {
      // Ordner existiert auf diesem Konto möglicherweise nicht
    } finally {
      try { await client.logout(); } catch (e) {}
    }
  }
}

export async function moveToErledigt(account, uid, sourceMailbox = 'INBOX') {
  const client = createClient(account);
  await client.connect();
  try {
    try { await client.mailboxCreate('Erledigt'); } catch(e) { /* existiert bereits */ }
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      await client.messageMove({ uid: `${uid}:${uid}` }, 'Erledigt', { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch(e) {}
  }
}

export async function syncErledigtStatus() {
  const accounts = await query('SELECT * FROM email_accounts WHERE active = 1');
  let total = 0;
  for (const acc of accounts) {
    try {
      const count = await syncErledigtStatusForAccount(acc);
      if (count > 0) console.log(`[IMAP] ${acc.email}: ${count} E-Mail(s) als erledigt markiert (nicht mehr in INBOX)`);
      total += count;
    } catch (e) {
      console.error(`[IMAP] syncErledigtStatus Fehler (${acc.email}):`, e.message);
    }
  }
  return total;
}

async function syncErledigtStatusForAccount(account) {
  const client = createClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const inboxUids = new Set(await client.search({ all: true }, { uid: true }));
      // Nur INBOX-E-Mails prüfen – Vorgang-Ordner-E-Mails werden hier nicht erledigt
      const dbEmails = await query(
        'SELECT id, uid FROM emails WHERE account_id = ? AND erledigt = 0 AND imap_mailbox = ?',
        [account.id, 'INBOX']
      );
      // Sicherheitscheck: leere INBOX bei vorhandenen DB-Einträgen ignorieren
      if (inboxUids.size === 0 && dbEmails.length > 0) return 0;
      let count = 0;
      for (const email of dbEmails) {
        if (!inboxUids.has(parseInt(email.uid))) {
          await query('UPDATE emails SET erledigt = 1 WHERE id = ?', [email.id]);
          count++;
        }
      }
      return count;
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (e) {}
  }
}

export async function getEmailContext(limitPerAccount = 8) {
  const accounts = await query('SELECT * FROM email_accounts WHERE active = 1');
  const lines = [];

  for (const acc of accounts) {
    const emails = await query(
      `SELECT id, from_name, from_email, subject, date, unread, body_text, vorgang_id
       FROM emails WHERE account_id = ?
       ORDER BY date DESC LIMIT ?`,
      [acc.id, limitPerAccount]
    );
    if (!emails.length) continue;
    lines.push(`\n## Konto: ${acc.label} <${acc.email}>`);
    for (const e of emails) {
      const u = e.unread ? '[UNGELESEN] ' : '';
      const d = e.date ? new Date(e.date).toLocaleString('de-DE') : '?';
      const v = e.vorgang_id ? `[Vorgang #${e.vorgang_id}] ` : '[nicht zugeordnet] ';
      const body = e.body_text ? '\n  Inhalt: ' + e.body_text.slice(0, 400).replace(/\n+/g, ' ') : '';
      lines.push(`- #${e.id} ${u}${v}${e.from_name || e.from_email}: "${e.subject}" (${d})${body}`);
    }
  }
  return lines.length ? lines.join('\n') : 'Keine E-Mails gecacht.';
}
