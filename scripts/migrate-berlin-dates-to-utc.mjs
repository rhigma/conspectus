/**
 * Einmaliges Migrations-Skript: verschiebt bestehende DATETIME-Werte, die als
 * Berlin-Wandzeit gespeichert wurden, auf UTC-Wandzeit. Hintergrund: bis zu
 * diesem Fix wurden Eingaben aus <input type="datetime-local"> (Berlin) roh
 * gespeichert. Der DB-Pool interpretiert DATETIME-Spalten jetzt konsequent als
 * UTC – deshalb müssen die Altwerte einmalig um den Berlin-Offset verschoben
 * werden.
 *
 * Betroffene Spalten:
 *   - bewerbungen.naechster_termin
 *   - todos.faellig_am
 *
 * Idempotent: Setzt nach erfolgreichem Lauf das Settings-Flag
 * `tz_migration_done_v1` und bricht bei erneutem Aufruf ab.
 *
 * Ausführen auf dem VPS:
 *   cd /opt/ki-assistent && node scripts/migrate-berlin-dates-to-utc.mjs
 *
 * Trockenlauf (zeigt nur, was passieren würde):
 *   node scripts/migrate-berlin-dates-to-utc.mjs --dry-run
 */

import 'dotenv/config';
import { query, queryOne } from '../src/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FLAG_KEY = 'tz_migration_done_v1';

// Berlin-Offset für ein gegebenes Datum: März–Oktober +02:00, sonst +01:00.
// Identische Näherung wie in caldav.js – einfach und ausreichend für alle
// Termine außerhalb der einen DST-Umstellungsnacht 02–03 Uhr.
function berlinOffsetMinutes(year, month /* 1-12 */) {
  return (month >= 3 && month <= 10) ? 120 : 60;
}

// MariaDB-Wandzeit-String ("YYYY-MM-DD HH:MM:SS" oder ISO) → JS Date in UTC,
// wobei der Wert als Berlin-Wandzeit interpretiert und nach UTC verschoben wird.
// Sonderfall: exakt 00:00:00 wird als reines Datum behandelt und NICHT verschoben
// (sonst landet ein "fällig am 15.05." um 22 Uhr am Vortag).
function berlinWallToUtc(raw) {
  // mysql2 liefert mit timezone:'Z' Date-Objekte; raw kann Date oder String sein.
  const s = raw instanceof Date
    ? raw.toISOString().replace('T', ' ').slice(0, 19)
    : String(raw).replace('T', ' ').slice(0, 19);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  if (hh === 0 && mm === 0 && ss === 0) return null; // Datum-only: nicht verschieben
  const offMin = berlinOffsetMinutes(y, mo);
  const utc = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss) - offMin * 60_000);
  return utc.toISOString();
}

// ── Idempotenz-Check ─────────────────────────────────────────────────────────
const flag = await queryOne("SELECT value FROM settings WHERE `key` = ?", [FLAG_KEY]);
if (flag && !DRY_RUN) {
  console.log(`Migration wurde bereits am ${flag.value} ausgeführt – Abbruch.`);
  console.log('Falls erneut nötig: DELETE FROM settings WHERE `key` = \'' + FLAG_KEY + '\';');
  process.exit(0);
}

const tag = DRY_RUN ? '[DRY-RUN]' : '[MIGRATION]';
console.log(`${tag} Verschiebe Berlin-Wandzeiten nach UTC …\n`);

let total = 0, updated = 0;

// ── Bewerbungen ──────────────────────────────────────────────────────────────
const bw = await query('SELECT id, naechster_termin FROM bewerbungen WHERE naechster_termin IS NOT NULL');
console.log(`bewerbungen.naechster_termin: ${bw.length} Zeilen`);
for (const row of bw) {
  total++;
  const neu = berlinWallToUtc(row.naechster_termin);
  if (!neu) { console.log(`  #${row.id}: ${row.naechster_termin} – kein Shift (Datum-only)`); continue; }
  console.log(`  #${row.id}: ${row.naechster_termin} → ${neu}`);
  if (!DRY_RUN) {
    await query('UPDATE bewerbungen SET naechster_termin = ? WHERE id = ?', [neu, row.id]);
  }
  updated++;
}

// ── Todos ────────────────────────────────────────────────────────────────────
const td = await query('SELECT id, faellig_am FROM todos WHERE faellig_am IS NOT NULL');
console.log(`\ntodos.faellig_am: ${td.length} Zeilen`);
for (const row of td) {
  total++;
  const neu = berlinWallToUtc(row.faellig_am);
  if (!neu) { console.log(`  #${row.id}: ${row.faellig_am} – kein Shift (Datum-only)`); continue; }
  console.log(`  #${row.id}: ${row.faellig_am} → ${neu}`);
  if (!DRY_RUN) {
    await query('UPDATE todos SET faellig_am = ? WHERE id = ?', [neu, row.id]);
  }
  updated++;
}

console.log(`\n${tag} Fertig: ${updated}/${total} Zeilen aktualisiert.`);

if (!DRY_RUN) {
  await query(
    "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [FLAG_KEY, new Date().toISOString()]
  );
  console.log(`Flag '${FLAG_KEY}' gesetzt – Skript wird beim nächsten Aufruf abbrechen.`);
}

process.exit(0);
