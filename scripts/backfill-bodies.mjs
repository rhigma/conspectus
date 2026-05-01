/**
 * Einmaliges Backfill-Skript: lädt Body für alle E-Mails nach, die noch
 * keinen Text haben. Gruppiert nach Konto, eine IMAP-Verbindung pro Konto.
 *
 * Ausführen auf dem VPS:
 *   cd /opt/ki-assistent && node scripts/backfill-bodies.mjs
 */

import 'dotenv/config';
import { query } from '../src/db.js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const emails = await query(`
  SELECT e.id, e.uid, e.account_id,
         a.host, a.port, a.username, a.password, a.tls, a.label
  FROM emails e
  JOIN email_accounts a ON a.id = e.account_id
  WHERE (e.body_text IS NULL OR e.body_text = '')
  ORDER BY e.account_id, e.date DESC
`);

if (!emails.length) { console.log('Alle E-Mails haben bereits einen Body.'); process.exit(0); }
console.log(`${emails.length} E-Mails ohne Body – starte Backfill…\n`);

// Nach Konto gruppieren – eine IMAP-Verbindung pro Konto
const byAccount = {};
for (const e of emails) {
  (byAccount[e.account_id] ??= { meta: e, list: [] }).list.push(e);
}

let totalOk = 0, totalSkip = 0, totalErr = 0;

for (const { meta, list } of Object.values(byAccount)) {
  console.log(`\n── Konto: ${meta.label} (${list.length} E-Mails)`);

  const client = new ImapFlow({
    host: meta.host, port: meta.port, secure: !!meta.tls,
    auth: { user: meta.username, pass: meta.password },
    logger: false, socketTimeout: 30000, connectionTimeout: 15000, disableAutoIdle: true,
  });
  client.on('error', () => {});

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const email of list) {
        try {
          let bodyText = '';
          for await (const msg of client.fetch(
            { uid: `${email.uid}:${email.uid}` },
            { source: true },
            { uid: true }
          )) {
            const parsed = await simpleParser(msg.source);
            bodyText = (parsed.text || '').slice(0, 10000);
            if (!bodyText && parsed.html) {
              bodyText = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
            }
          }

          if (bodyText) {
            await query('UPDATE emails SET body_text = ? WHERE id = ?', [bodyText, email.id]);
            process.stdout.write(`  ✓ #${email.id}\n`);
            totalOk++;
          } else {
            process.stdout.write(`  ○ #${email.id} (kein Text gefunden)\n`);
            totalSkip++;
          }
        } catch (e) {
          process.stdout.write(`  ✗ #${email.id}: ${e.message.slice(0, 60)}\n`);
          totalErr++;
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error(`  Verbindungsfehler für ${meta.label}: ${e.message}`);
    totalErr += list.length;
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

console.log(`\n──────────────────────────────────`);
console.log(`Fertig: ${totalOk} nachgeladen, ${totalSkip} ohne Text, ${totalErr} Fehler`);
process.exit(0);
