/**
 * Einmaliges Backfill-Skript: KI-Zusammenfassung für PDF-Anhänge nachholen,
 * die noch keine `analyse` im anhang_pfade-JSON haben. Berücksichtigt alle
 * E-Mails — INBOX, Vorgang-Ordner und Erledigt.
 *
 * Ausführen auf dem VPS:
 *   cd /opt/ki-assistent && node scripts/backfill-anhang-analyse.mjs
 *
 * Optionen:
 *   --max-kb=N   PDFs größer als N KB überspringen (Default: 2048 = 2 MB)
 *   --limit=N    Nur die N neuesten E-Mails mit Anhängen prüfen (Default: alle)
 *   --reeinordnen  Nach jeder erfolgreichen Anhang-Analyse emailEinordnen
 *                  neu laufen lassen, damit die Zusammenfassung in die
 *                  Triage einfließt.
 */

import 'dotenv/config';
import { query } from '../src/db.js';
import { anhangZusammenfassen, emailEinordnen } from '../src/ai.js';
import { ncDownload } from '../src/nextcloud.js';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const MAX_KB = parseInt(args['max-kb']) || 2048;
const LIMIT  = parseInt(args.limit) || 0;
const REEIN  = !!args.reeinordnen;

const sql = `
  SELECT id, subject, anhang_pfade
  FROM emails
  WHERE anhang_pfade IS NOT NULL
    AND anhang_pfade != '[]'
    AND anhang_pfade != ''
  ORDER BY date DESC
  ${LIMIT ? 'LIMIT ?' : ''}`;
const emails = await query(sql, LIMIT ? [LIMIT] : []);

if (!emails.length) {
  console.log('Keine E-Mails mit Anhängen gefunden.');
  process.exit(0);
}
console.log(`${emails.length} E-Mails mit Anhängen werden geprüft (max ${MAX_KB} KB pro PDF)…\n`);

let touchedEmails = 0, neuAnalysiert = 0, skip = 0, err = 0, reein = 0;

for (const email of emails) {
  let liste;
  try { liste = JSON.parse(email.anhang_pfade); } catch (_) { continue; }
  if (!Array.isArray(liste) || !liste.length) continue;

  let mailDirty = false;
  for (let i = 0; i < liste.length; i++) {
    const a = liste[i];
    if (!a?.pfad) continue;
    if (a.analyse?.zusammenfassung) { skip++; continue; }
    if ((a.typ || '') !== 'application/pdf') { skip++; continue; }
    if (a.groesse && a.groesse > MAX_KB * 1024) {
      process.stdout.write(`  ⤳ #${email.id} ${a.name} (${Math.round(a.groesse/1024)} KB) — übersprungen, > ${MAX_KB} KB\n`);
      skip++;
      continue;
    }
    try {
      const buf = await ncDownload(a.pfad);
      const analyse = await anhangZusammenfassen(buf, a.typ, a.name);
      if (analyse?.zusammenfassung) {
        liste[i] = { ...a, analyse };
        mailDirty = true;
        neuAnalysiert++;
        process.stdout.write(`  ✓ #${email.id} ${a.name}: ${analyse.zusammenfassung.slice(0, 80)}…\n`);
      } else {
        skip++;
        process.stdout.write(`  ○ #${email.id} ${a.name} — keine Zusammenfassung möglich\n`);
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      err++;
      process.stdout.write(`  ✗ #${email.id} ${a.name}: ${e.message.slice(0, 80)}\n`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (mailDirty) {
    await query('UPDATE emails SET anhang_pfade = ? WHERE id = ?', [JSON.stringify(liste), email.id]);
    touchedEmails++;

    if (REEIN) {
      try {
        const fresh = await query('SELECT * FROM emails WHERE id = ?', [email.id]);
        const r = await emailEinordnen(fresh[0]);
        if (r) {
          await query('UPDATE emails SET ki_einordnung = ? WHERE id = ?', [JSON.stringify(r), email.id]);
          reein++;
          process.stdout.write(`     ↻ Einordnung neu (Prio ${r.ki_prioritaet || '?'})\n`);
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        process.stdout.write(`     ✗ Re-Einordnung: ${e.message.slice(0, 60)}\n`);
      }
    }
  }
}

console.log(`\n──────────────────────────────────`);
console.log(`E-Mails aktualisiert: ${touchedEmails}`);
console.log(`Anhänge analysiert:   ${neuAnalysiert}`);
console.log(`Übersprungen:         ${skip}`);
console.log(`Fehler:               ${err}`);
if (REEIN) console.log(`Re-Einordnungen:      ${reein}`);
process.exit(0);
