import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query, queryOne } from './db.js';
import { speichereAnhang } from './nextcloud.js';

const MAX_EMAILS = 200;

export async function syncAllAccounts() {
  const accounts = await query('SELECT * FROM email_accounts WHERE active = 1');
  const results = [];

  for (const acc of accounts) {
    const start = Date.now();
    try {
      const count = await syncAccount(acc);
      await query(
        'INSERT INTO sync_log (type, status, message, duration_ms) VALUES (?,?,?,?)',
        ['email', 'ok', `${acc.email}: ${count} neue`, Date.now() - start]
      );
      results.push({ account: acc.label, status: 'ok', new: count });
    } catch (err) {
      await query(
        'INSERT INTO sync_log (type, status, message, duration_ms) VALUES (?,?,?,?)',
        ['email', 'error', `${acc.email}: ${err.message}`, Date.now() - start]
      );
      results.push({ account: acc.label, status: 'error', error: err.message });
    }
  }

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

  await client.connect();
  let newCount = 0;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      if (total === 0) return 0;
      const from = Math.max(1, total - MAX_EMAILS + 1);

      // Pass 1: Envelopes – neue UIDs ermitteln
      const neueMsgs = [];
      for await (const msg of client.fetch(`${from}:${total}`, {
        uid: true, flags: true, envelope: true,
      })) {
        const exists = await queryOne(
          'SELECT id FROM emails WHERE account_id = ? AND uid = ?',
          [account.id, String(msg.uid)]
        );
        if (!exists) neueMsgs.push({
          uid: msg.uid, flags: msg.flags, envelope: msg.envelope,
        });
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
        await query(
          `INSERT IGNORE INTO emails
            (account_id, uid, message_id, from_name, from_email, subject, body_text, date, unread, anhang_pfade)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
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

export async function getEmailContext(limitPerAccount = 8) {
  const accounts = await query('SELECT * FROM email_accounts WHERE active = 1');
  const lines = [];

  for (const acc of accounts) {
    const emails = await query(
      `SELECT from_name, from_email, subject, date, unread, body_text, vorgang_id
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
      lines.push(`- ${u}${v}${e.from_name || e.from_email}: "${e.subject}" (${d})${body}`);
    }
  }
  return lines.length ? lines.join('\n') : 'Keine E-Mails gecacht.';
}
