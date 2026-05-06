/**
 * Einmaliges Backfill-Skript: E-Mails im "Erledigt"-Ordner, die einem Vorgang
 * zugeordnet sind, in den jeweiligen Vorgänge/<Titel>-Ordner verschieben.
 *
 * Ausführen auf dem VPS:
 *   cd /opt/ki-assistent && node scripts/backfill-vorgang-ordner.mjs
 */

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { query, queryOne, initSchema } from '../src/db.js';
import { vorgangFolderPath } from '../src/imap.js';

await initSchema();

const accounts = await query('SELECT * FROM email_accounts WHERE active = 1');
let total = 0, verschoben = 0, fehler = 0;

for (const acc of accounts) {
  console.log(`\n── Konto: ${acc.label} <${acc.email}>`);

  const client = new ImapFlow({
    host: acc.host, port: acc.port, secure: !!acc.tls,
    auth: { user: acc.username, pass: acc.password },
    logger: false, socketTimeout: 30000, connectionTimeout: 15000,
    disableAutoIdle: true,
  });
  client.on('error', () => {});

  try {
    await client.connect();

    // Prüfen ob Erledigt-Ordner existiert
    const folders = await client.list();
    if (!folders.some(f => f.path === 'Erledigt')) {
      console.log('  Kein Erledigt-Ordner gefunden, überspringe.');
      continue;
    }

    const lock = await client.getMailboxLock('Erledigt');
    try {
      const msgCount = client.mailbox.exists;
      if (msgCount === 0) { console.log('  Erledigt-Ordner ist leer.'); continue; }
      console.log(`  ${msgCount} Nachrichten im Erledigt-Ordner.`);

      // Alle UIDs + Message-IDs aus dem Erledigt-Ordner holen
      const msgs = [];
      for await (const msg of client.fetch('1:*', { uid: true, envelope: true }, { uid: false })) {
        msgs.push({ uid: msg.uid, messageId: msg.envelope?.messageId || null });
      }

      for (const msg of msgs) {
        total++;

        // Per message_id in DB nachschlagen
        let dbEmail = null;
        if (msg.messageId) {
          dbEmail = await queryOne(
            'SELECT e.id, e.vorgang_id, e.uid FROM emails e WHERE e.account_id = ? AND e.message_id = ?',
            [acc.id, msg.messageId]
          );
        }
        // Fallback: per UID (falls imap_mailbox noch 'Erledigt' gesetzt)
        if (!dbEmail) {
          dbEmail = await queryOne(
            "SELECT id, vorgang_id, uid FROM emails WHERE account_id = ? AND uid = ? AND imap_mailbox = 'Erledigt'",
            [acc.id, String(msg.uid)]
          );
        }

        if (!dbEmail || !dbEmail.vorgang_id) continue;

        // Zugehörigen Vorgang laden
        const vorgang = await queryOne(
          'SELECT id, titel, imap_folder FROM vorgaenge WHERE id = ?',
          [dbEmail.vorgang_id]
        );
        if (!vorgang) continue;

        // imap_folder bestimmen (anlegen falls noch nicht gesetzt)
        let folderPath = vorgang.imap_folder;
        if (!folderPath) {
          folderPath = vorgangFolderPath(vorgang.titel);
          await query('UPDATE vorgaenge SET imap_folder = ? WHERE id = ?', [folderPath, vorgang.id]);
        }

        // Vorgang-Ordner sicherstellen
        try { await client.mailboxCreate('Vorgänge'); } catch (e) {}
        try { await client.mailboxCreate(folderPath); } catch (e) {}

        // Verschieben (Erledigt-Lock ist bereits offen)
        try {
          const result = await client.messageMove(
            { uid: `${msg.uid}:${msg.uid}` },
            folderPath,
            { uid: true }
          );
          const newUid = result?.uidMap?.get(msg.uid);
          await query(
            'UPDATE emails SET imap_mailbox = ?, uid = ? WHERE id = ?',
            [folderPath, newUid ? String(newUid) : dbEmail.uid, dbEmail.id]
          );
          console.log(`  ✓ UID ${msg.uid} → ${folderPath} (Vorgang: ${vorgang.titel})`);
          verschoben++;
        } catch (e) {
          console.warn(`  ✗ UID ${msg.uid} Fehler: ${e.message}`);
          fehler++;
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error(`  Verbindungsfehler: ${e.message}`);
  } finally {
    try { await client.logout(); } catch (e) {}
  }
}

console.log(`\n── Ergebnis: ${total} geprüft, ${verschoben} verschoben, ${fehler} Fehler`);
