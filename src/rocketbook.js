import { query, queryOne } from './db.js';
import { speichereRocketbookPdf, vorgangOrdner } from './nextcloud.js';
import { notizAnalysieren } from './ai.js';

// Setting-Key + Default für die E-Mail-basierte Rocketbook-Erkennung.
// Rocketbook scannt Notizseiten und schickt sie als PDF-Anhang —
// der Body ist Marketing/Boilerplate und wird verworfen.
export const ROCKETBOOK_EMAIL_SETTING = 'rocketbook_email_absender';
const DEFAULT_ROCKETBOOK_PATTERN = '@email.getrocketbook.com';

export async function getRocketbookAbsenderPattern() {
  const row = await queryOne(
    'SELECT value FROM settings WHERE `key` = ?',
    [ROCKETBOOK_EMAIL_SETTING]
  );
  return (row?.value || '').trim() || DEFAULT_ROCKETBOOK_PATTERN;
}

const normItem = (extra = {}) => ({ status: 'offen', ref_id: null, ...extra });
const normVorschlaege = (analyse) => ({
  ...analyse,
  aufgaben: (analyse.aufgaben || []).map(a => typeof a === 'string' ? normItem({ titel: a }) : normItem(a)),
  delegationen: (analyse.delegationen || []).map(d => normItem(d)),
  termine: (analyse.termine || []).map(t => normItem(t)),
});

function safeFilename(s) {
  return (s || '').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120);
}

export async function rocketbookVerarbeiten({
  titel,
  pdfBuffer,
  dateiname,
  empfangenAm,
}) {
  const ncPfad = await speichereRocketbookPdf(pdfBuffer, titel || dateiname || 'rocketbook', empfangenAm)
    .catch(e => { console.warn('[Rocketbook] NC-Upload:', e.message); return null; });

  const analyse = await notizAnalysieren(pdfBuffer.toString('base64'), 'application/pdf', []);
  const neueVorschlaege = normVorschlaege(analyse);

  // Bewusst KEINE Auto-Zuordnung: alle Rocketbook-Einträge landen im Sammel-
  // Vorgang, der User entscheidet manuell über die Zuordnung. Den Titel-
  // Vorschlag der KI (egal ob bestehender Vorgang oder neuer Titel) speichern
  // wir als Vorschlag — das `/vorgang-aus-vorschlag`-Endpoint matcht via LIKE
  // und nutzt einen bestehenden Vorgang wieder bzw. legt einen neuen an.
  let vorgangVorschlag = null;
  if (analyse.vorgang_id) {
    const vorhanden = await queryOne(
      'SELECT titel FROM vorgaenge WHERE id = ? LIMIT 1',
      [parseInt(analyse.vorgang_id)]
    );
    if (vorhanden?.titel) vorgangVorschlag = vorhanden.titel;
  }
  if (!vorgangVorschlag && analyse.vorgang_titel) {
    vorgangVorschlag = analyse.vorgang_titel;
  }

  let vorgangId;
  const sammel = await queryOne(
    `SELECT id FROM vorgaenge WHERE titel = 'Notizen ohne Zuordnung' LIMIT 1`
  );
  if (sammel) {
    vorgangId = sammel.id;
  } else {
    const ncOrdnerPfad = await vorgangOrdner('Notizen ohne Zuordnung').catch(() => null);
    const result = await query(
      `INSERT INTO vorgaenge (titel, typ, beschreibung, nc_ordner)
       VALUES ('Notizen ohne Zuordnung', 'sonstiges', 'Sammelvorgang für nicht zugeordnete PDF-Notizen', ?)`,
      [ncOrdnerPfad]
    );
    vorgangId = result.insertId;
  }

  const inhalt = {
    ...neueVorschlaege,
    empfangen_am: empfangenAm || null,
    quelle: 'rocketbook_email',
    vorgang_vorschlag: vorgangVorschlag,
  };
  // Doppeltes "Rocketbook" im Betreff entfernen — Rocketbook nennt seine
  // Mails standardmäßig "Rocketbook Scan - <Datum>", was sonst zu
  // "Rocketbook: Rocketbook Scan - …" führt.
  const titelStripped = (titel || dateiname || 'Notiz').replace(/^rocketbook\s*[-:]?\s*/i, '').trim() || 'Notiz';
  const eintragTitel = `Rocketbook: ${safeFilename(titelStripped)}`;
  const result = await query(
    'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, datei_pfad) VALUES (?,?,?,?,?)',
    [vorgangId, 'notiz', eintragTitel, JSON.stringify(inhalt), ncPfad]
  );

  const offen = neueVorschlaege.aufgaben.length + neueVorschlaege.delegationen.length + neueVorschlaege.termine.length;
  try {
    const vorgang = await queryOne('SELECT titel FROM vorgaenge WHERE id = ?', [vorgangId]);
    const { pushRocketbookVerarbeitet } = await import('./pushover.js');
    await pushRocketbookVerarbeitet(titel || dateiname || 'Notiz', vorgang?.titel || null, analyse.zusammenfassung || '', offen);
  } catch (e) {
    console.warn('[Rocketbook] Push fehlgeschlagen:', e.message);
  }

  console.log(`[Rocketbook] "${titel || dateiname}" → Vorgang #${vorgangId}, ${analyse.seiten || 0} Seiten, ${offen} Vorschläge`);
  return {
    eintragId: result.insertId,
    vorgangId,
    ncPfad,
    vorschlaege: offen,
    analyse: inhalt,
  };
}
