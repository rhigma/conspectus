/**
 * Einmaliges Backfill-Skript: KI-Zusammenfassung für alle E-Mails nachholen,
 * die bereits eine ki_einordnung haben, aber noch kein "zusammenfassung"-Feld.
 *
 * Ausführen auf dem VPS:
 *   cd /opt/ki-assistent && node scripts/backfill-ki-zusammenfassung.mjs
 *
 * Optional: nur die letzten N E-Mails verarbeiten (Standard: 200)
 *   node scripts/backfill-ki-zusammenfassung.mjs 50
 */

import 'dotenv/config';
import { query } from '../src/db.js';
import { emailEinordnen } from '../src/ai.js';

const limit = parseInt(process.argv[2]) || 200;

const emails = await query(
  `SELECT * FROM emails
   WHERE ki_einordnung IS NOT NULL
     AND ki_einordnung NOT LIKE '%zusammenfassung%'
   ORDER BY date DESC
   LIMIT ?`,
  [limit]
);

if (!emails.length) {
  console.log('Alle analysierten E-Mails haben bereits eine Zusammenfassung.');
  process.exit(0);
}
console.log(`${emails.length} E-Mails zu ergänzen (Limit: ${limit})…\n`);

let ok = 0, skip = 0, err = 0;

for (const email of emails) {
  try {
    const result = await emailEinordnen(email);
    if (result?.zusammenfassung !== undefined) {
      await query('UPDATE emails SET ki_einordnung = ? WHERE id = ?',
        [JSON.stringify(result), email.id]);
      process.stdout.write(`  ✓ #${email.id} – ${(result.zusammenfassung || '(leer)').slice(0, 80)}\n`);
      ok++;
    } else {
      process.stdout.write(`  ○ #${email.id} (kein Ergebnis)\n`);
      skip++;
    }
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    process.stdout.write(`  ✗ #${email.id}: ${e.message.slice(0, 60)}\n`);
    err++;
    await new Promise(r => setTimeout(r, 1000));
  }
}

console.log(`\n──────────────────────────────────`);
console.log(`Fertig: ${ok} ergänzt, ${skip} übersprungen, ${err} Fehler`);
process.exit(0);
