/**
 * Einmaliges Backfill-Skript: KI-Analyse (Schlagworte + Priorität) für alle
 * E-Mails nachholen, die noch keine erweiterte Analyse haben.
 *
 * Ausführen auf dem VPS:
 *   cd /opt/ki-assistent && node scripts/backfill-ki-analyse.mjs
 *
 * Optional: nur die letzten N E-Mails analysieren (Standard: 500)
 *   node scripts/backfill-ki-analyse.mjs 100
 */

import 'dotenv/config';
import { query } from '../src/db.js';
import { emailEinordnen } from '../src/ai.js';

const limit = parseInt(process.argv[2]) || 500;

const emails = await query(
  `SELECT * FROM emails
   WHERE (ki_einordnung IS NULL OR ki_einordnung NOT LIKE '%schlagworte%')
     AND erledigt = 0
   ORDER BY date DESC
   LIMIT ?`,
  [limit]
);

if (!emails.length) {
  console.log('Alle E-Mails haben bereits eine erweiterte KI-Analyse.');
  process.exit(0);
}
console.log(`${emails.length} E-Mails zu analysieren (Limit: ${limit})…\n`);

let ok = 0, skip = 0, err = 0;

for (const email of emails) {
  try {
    const result = await emailEinordnen(email);
    if (result?.schlagworte) {
      await query('UPDATE emails SET ki_einordnung = ? WHERE id = ?',
        [JSON.stringify(result), email.id]);
      const prio = result.ki_prioritaet || '?';
      const tags = (result.schlagworte || []).join(', ');
      process.stdout.write(`  ✓ #${email.id} [${prio}] ${tags}\n`);
      ok++;
    } else {
      process.stdout.write(`  ○ #${email.id} (kein Ergebnis)\n`);
      skip++;
    }
    // Kurze Pause – Haiku-API nicht überlasten
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    process.stdout.write(`  ✗ #${email.id}: ${e.message.slice(0, 60)}\n`);
    err++;
    await new Promise(r => setTimeout(r, 1000));
  }
}

console.log(`\n──────────────────────────────────`);
console.log(`Fertig: ${ok} analysiert, ${skip} übersprungen, ${err} Fehler`);
process.exit(0);
