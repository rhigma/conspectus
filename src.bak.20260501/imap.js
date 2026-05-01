import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb } from './db.js';

const MAX_EMAILS_PER_ACCOUNT = 200;

/**
 * Synchronisiert alle aktiven IMAP-Konten.
 * Gibt eine Zusammenfassung zurück.
 */
export async function syncAllAccounts() {
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM email_accounts WHERE active = 1').all();
  const results = [];

  for (const account of accounts) {
    const start = Date.now();
    try {
      const count = await syncAccount(account);
      const ms = Date.now() - start;
      db.prepare(`INSERT INTO sync_log (type, account_id, status, message, duration_ms)
                  VALUES ('email', ?, 'ok', ?, ?)`).run(account.id, `${count} neue E-Mails`, ms);
      results.push({ account: account.label, status: 'ok', new: count });
    } catch (err) {
      const ms = Date.now() - start;
      db.prepare(`INSERT INTO sync_log (type, account_id, status, message, duration_ms)
                  VALUES ('email', ?, 'error', ?, ?)`).run(account.id, err.message, ms);
      results.push({ account: account.label, status: 'error', error: err.message });
    }
  }
  return results;
}

async function syncAccount(account) {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: !!account.tls,
    auth: { user: account.username, pass: account.password },
    logger: false,
    disableAutoIdle: true,
    socketTimeout: 15000,
    connectionTimeout: 10000,
  });

  // Verhindert unhandled error crash
  client.on('error', (err) => { /* abgefangen */ });
  try {
    await client.connect();
  } catch(connErr) {
    throw connErr;
  }
  let newCount = 0;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Neueste MAX_EMAILS_PER_ACCOUNT Nachrichten holen
      const total = client.mailbox.exists;
      const from = Math.max(1, total - MAX_EMAILS_PER_ACCOUNT + 1);
      const range = `${from}:${total}`;

      for await (const msg of client.fetch(range, {
        uid: true, flags: true, envelope: true, bodyStructure: true
      })) {
        const uid = String(msg.uid);
        const exists = getDb()
          .prepare('SELECT id FROM emails WHERE account_id = ? AND uid = ?')
          .get(account.id, uid);
        if (exists) continue;

        // Body laden
        let bodyText = '';
        try {
          const raw = await client.download(`${msg.seq}`, undefined, { uid: false });
          const parsed = await simpleParser(raw.content);
          bodyText = parsed.text?.slice(0, 2000) || '';
        } catch { /* body optional */ }

        const env = msg.envelope;
        getDb().prepare(`
          INSERT OR IGNORE INTO emails
            (account_id, uid, message_id, from_name, from_email, subject, body_text, date, unread)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          account.id, uid,
          env.messageId || null,
          env.from?.[0]?.name || null,
          env.from?.[0]?.address || null,
          env.subject || '(kein Betreff)',
          bodyText,
          env.date?.toISOString() || null,
          msg.flags.has('\\Seen') ? 0 : 1
        );
        newCount++;
      }

      // Alte Einträge trimmen
      getDb().prepare(`
        DELETE FROM emails WHERE account_id = ? AND id NOT IN (
          SELECT id FROM emails WHERE account_id = ? ORDER BY date DESC LIMIT ?
        )
      `).run(account.id, account.id, MAX_EMAILS_PER_ACCOUNT);

    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return newCount;
}

/** Liefert einen kompakten Kontext-String für Claude */
export function getEmailContext(limitPerAccount = 10) {
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM email_accounts WHERE active = 1').all();
  const lines = [];

  for (const acc of accounts) {
    const emails = db.prepare(`
      SELECT from_name, from_email, subject, date, unread
      FROM emails WHERE account_id = ?
      ORDER BY date DESC LIMIT ?
    `).all(acc.id, limitPerAccount);

    if (emails.length === 0) continue;
    lines.push(`\n## Konto: ${acc.label} <${acc.email}>`);
    for (const e of emails) {
      const unread = e.unread ? '[UNGELESEN] ' : '';
      const date = e.date ? new Date(e.date).toLocaleString('de-DE') : '?';
      lines.push(`- ${unread}${e.from_name || e.from_email}: "${e.subject}" (${date})`);
    }
  }

  return lines.length ? lines.join('\n') : 'Keine E-Mails gecacht.';
}
