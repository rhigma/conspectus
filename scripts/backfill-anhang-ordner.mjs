/**
 * Einmaliges Backfill-Skript: Anhang- und Vorgang-Ordner-Struktur aufräumen.
 *
 * Was passiert:
 *   1. Alle bekannten E-Mail-Anhänge mit altem flachen Pfad
 *      (/E-Mail-Anhänge/Anhänge/<uid>_<datei>) werden umgezogen:
 *        - Mail einem Vorgang zugeordnet → /Conspectus/Vorgaenge/<titel>/Anhänge/
 *        - sonst                          → /Conspectus/E-Mail-Anhänge/<JJJJ>/<MM>/
 *      Pfade in anhang_pfade-JSON werden mitaktualisiert.
 *   2. Mit --vorgang-ordner: bestehende /Vorgaenge/<titel>-Ordner werden nach
 *      /Conspectus/Vorgaenge/<titel> verschoben und nc_ordner in der DB
 *      aktualisiert. Reine Stand-Operation, sicher rerunnbar.
 *
 * Defensiv: nur Pfade, die in unserer DB stehen, werden angefasst — fremde
 * Dateien im /E-Mail-Anhänge/ (z.B. von Nextcloud Mail) bleiben unberührt.
 *
 * Ausführen auf dem VPS:
 *   cd /opt/ki-assistent && node scripts/backfill-anhang-ordner.mjs
 *
 * Optionen:
 *   --vorgang-ordner   Auch Vorgang-Ordner /Vorgaenge → /Conspectus/Vorgaenge umziehen
 *   --dry-run          Nur anzeigen, was passieren würde
 */

import 'dotenv/config';
import { query, queryOne } from '../src/db.js';
import {
  ncMove, ncMkdir, vorgangOrdner,
  NC_BASIS, NC_VORGAENGE_BASIS, NC_EMAIL_ANHAENGE_BASIS,
} from '../src/nextcloud.js';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const VORGANG_MOVE = args.has('--vorgang-ordner');

const log = (...a) => console.log(DRY ? '[DRY]' : '     ', ...a);

await ncMkdir(NC_BASIS).catch(() => {});

// ── 1) Vorgang-Ordner umziehen (optional) ────────────────────────────────────
if (VORGANG_MOVE) {
  console.log(`\n=== Vorgang-Ordner: /Vorgaenge/* → ${NC_VORGAENGE_BASIS}/* ===`);
  await ncMkdir(NC_VORGAENGE_BASIS).catch(() => {});
  const vorgaenge = await query(
    `SELECT id, titel, nc_ordner FROM vorgaenge
     WHERE nc_ordner IS NOT NULL AND nc_ordner LIKE '/Vorgaenge/%'`
  );
  console.log(`${vorgaenge.length} Vorgang-Ordner zu prüfen.\n`);
  let okV = 0, skipV = 0, errV = 0;
  for (const v of vorgaenge) {
    const neu = NC_VORGAENGE_BASIS + v.nc_ordner.slice('/Vorgaenge'.length);
    if (DRY) { log(`#${v.id} "${v.titel}": ${v.nc_ordner} → ${neu}`); continue; }
    try {
      const moved = await ncMove(v.nc_ordner, neu);
      if (moved) {
        await query('UPDATE vorgaenge SET nc_ordner = ? WHERE id = ?', [neu, v.id]);
        log(`✓ #${v.id} ${v.titel}`); okV++;
      } else {
        // Quelle existiert nicht — DB-Pfad trotzdem auf neuen Standard ziehen,
        // damit künftige Anhang-Moves zum richtigen Ort landen.
        await query('UPDATE vorgaenge SET nc_ordner = ? WHERE id = ?', [neu, v.id]);
        log(`⤳ #${v.id} ${v.titel}: Quelle weg, DB aktualisiert`); skipV++;
      }
    } catch (e) {
      console.warn(`  ✗ #${v.id} ${v.titel}: ${e.message}`); errV++;
    }
  }
  console.log(`\nVorgang-Ordner: ${okV} verschoben, ${skipV} übersprungen, ${errV} Fehler.`);
}

// ── 2) E-Mail-Anhänge umziehen ───────────────────────────────────────────────
console.log(`\n=== E-Mail-Anhänge umziehen ===`);
await ncMkdir(NC_EMAIL_ANHAENGE_BASIS).catch(() => {});

const emails = await query(
  `SELECT e.id, e.account_id, e.uid, e.date, e.vorgang_id, e.anhang_pfade,
          v.titel AS vorgang_titel, v.nc_ordner AS vorgang_nc_ordner
   FROM emails e
   LEFT JOIN vorgaenge v ON v.id = e.vorgang_id
   WHERE e.anhang_pfade IS NOT NULL
     AND e.anhang_pfade != '[]'
     AND e.anhang_pfade != ''
     AND (e.anhang_pfade LIKE '%/E-Mail-Anh%/Anh%' OR e.anhang_pfade LIKE '/Vorgaenge/%')
   ORDER BY e.date DESC`
);
console.log(`${emails.length} E-Mails mit potentiell altem Anhang-Pfad.\n`);

let touched = 0, movedFiles = 0, skipFiles = 0, errFiles = 0;

// Cache: Vorgang-NC-Ordner sicherstellen (anlegen wenn fehlend)
const vorgangOrdnerCache = new Map();
async function ensureVorgangOrdner(vorgangId, titel, current) {
  if (vorgangOrdnerCache.has(vorgangId)) return vorgangOrdnerCache.get(vorgangId);
  let ordner = current;
  if (!ordner || !ordner.startsWith(NC_VORGAENGE_BASIS + '/')) {
    if (!DRY) {
      ordner = await vorgangOrdner(titel);
      await query('UPDATE vorgaenge SET nc_ordner = ? WHERE id = ?', [ordner, vorgangId]);
    } else {
      ordner = `${NC_VORGAENGE_BASIS}/${titel.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80)}`;
    }
  }
  vorgangOrdnerCache.set(vorgangId, ordner);
  return ordner;
}

for (const e of emails) {
  let liste; try { liste = JSON.parse(e.anhang_pfade); } catch { continue; }
  if (!Array.isArray(liste) || !liste.length) continue;

  // Ziel-Ordner bestimmen
  let zielOrdner;
  if (e.vorgang_id && e.vorgang_titel) {
    const vOrdner = await ensureVorgangOrdner(e.vorgang_id, e.vorgang_titel, e.vorgang_nc_ordner);
    zielOrdner = `${vOrdner}/Anhänge`;
  } else {
    const d = e.date ? new Date(e.date) : new Date();
    const jahr = String(d.getFullYear());
    const monat = String(d.getMonth() + 1).padStart(2, '0');
    zielOrdner = `${NC_EMAIL_ANHAENGE_BASIS}/${jahr}/${monat}`;
  }

  let dirty = false;
  let anyMoved = false;
  for (let i = 0; i < liste.length; i++) {
    const a = liste[i];
    if (!a?.pfad) continue;
    // Schon am Ziel? (idempotent)
    if (a.pfad.startsWith(zielOrdner + '/')) { skipFiles++; continue; }
    const dateiname = a.pfad.split('/').pop();
    const neuerPfad = `${zielOrdner}/${dateiname}`;
    if (DRY) { log(`#${e.id}: ${a.pfad} → ${neuerPfad}`); continue; }
    try {
      // Zielordner sicherstellen (mehrstufig anlegen)
      if (!e.vorgang_id) {
        const d = e.date ? new Date(e.date) : new Date();
        const jahr = String(d.getFullYear());
        await ncMkdir(NC_EMAIL_ANHAENGE_BASIS).catch(() => {});
        await ncMkdir(`${NC_EMAIL_ANHAENGE_BASIS}/${jahr}`).catch(() => {});
      }
      await ncMkdir(zielOrdner).catch(() => {});
      const ok = await ncMove(a.pfad, neuerPfad);
      if (ok) {
        liste[i] = { ...a, pfad: neuerPfad };
        dirty = true; anyMoved = true; movedFiles++;
        process.stdout.write(`  ✓ #${e.id} ${dateiname}\n`);
      } else {
        // Quelle weg — DB-Pfad auf neuen Standard, damit Folgeläufe nicht stolpern.
        liste[i] = { ...a, pfad: neuerPfad, _missing: true };
        dirty = true; skipFiles++;
        process.stdout.write(`  ⤳ #${e.id} ${dateiname} (Quelle weg)\n`);
      }
    } catch (err) {
      errFiles++;
      process.stdout.write(`  ✗ #${e.id} ${dateiname}: ${err.message.slice(0, 80)}\n`);
    }
  }

  if (dirty && !DRY) {
    await query('UPDATE emails SET anhang_pfade = ? WHERE id = ?', [JSON.stringify(liste), e.id]);
    if (anyMoved) touched++;
  }
}

console.log(`\n──────────────────────────────────`);
console.log(`E-Mails aktualisiert: ${touched}`);
console.log(`Dateien verschoben:   ${movedFiles}`);
console.log(`Übersprungen:         ${skipFiles}`);
console.log(`Fehler:               ${errFiles}`);
if (DRY) console.log(`(Dry-Run — keine Änderungen wurden geschrieben.)`);
process.exit(0);
