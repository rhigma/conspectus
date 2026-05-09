import fetch from 'node-fetch';
import { query, queryOne } from './db.js';
import { speichereDiktatAudio, vorgangOrdner } from './nextcloud.js';
import { diktatAnalysieren } from './ai.js';

// Setting-Key + Default für die E-Mail-basierte Plaud-Erkennung.
export const DIKTAT_EMAIL_SETTING = 'diktat_email_absender';
const DEFAULT_PLAUD_PATTERN = '@plaud.ai';

export async function getPlaudAbsenderPattern() {
  const row = await queryOne(
    'SELECT value FROM settings WHERE `key` = ?',
    [DIKTAT_EMAIL_SETTING]
  );
  return (row?.value || '').trim() || DEFAULT_PLAUD_PATTERN;
}

// Entfernt die typischen Plaud-Footers ("View in Plaud", Marketing-Links) sowie
// klassische "-- "-Email-Signaturen. Bewusst defensiv: was nicht eindeutig
// Boilerplate ist, bleibt drin — die KI-Analyse verkraftet ein paar Restzeilen.
export function cleanPlaudBody(text) {
  if (!text) return '';
  let s = String(text).replace(/\r\n/g, '\n').trim();

  // Footer ab erster "View/Open in Plaud"-Zeile o.ä. abschneiden
  const footerStart = s.search(/(^|\n)\s*(View in Plaud|Open in Plaud|Manage your account|Unsubscribe|© Plaud)/i);
  if (footerStart > 0) s = s.slice(0, footerStart).trim();

  // Standard-Email-Signatur "-- " auf eigener Zeile
  s = s.replace(/\n--\s*\n[\s\S]*$/, '').trim();

  return s;
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

export async function diktatVerarbeiten({
  titel,
  transkript,
  aufgenommenAm,
  audioUrl = null,
  dauerSekunden = null,
  zusammenfassungPlaud = null,
  quelle = 'plaud',
}) {
  // 1) Audio (optional) auf Nextcloud sichern
  let audioPfad = null;
  if (audioUrl) {
    try {
      const r = await fetch(audioUrl);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        audioPfad = await speichereDiktatAudio(buf, titel, aufgenommenAm);
      } else {
        console.warn('[Diktat] Audio-Download HTTP', r.status);
      }
    } catch (e) {
      console.warn('[Diktat] Audio-Download fehlgeschlagen:', e.message);
    }
  }

  // 2) KI-Analyse (text-only, MODEL_FAST)
  const analyse = await diktatAnalysieren(transkript, aufgenommenAm);
  const neueVorschlaege = normVorschlaege(analyse);

  // 3) Vorgang auflösen — nur bestehende Vorgänge zuordnen.
  //    Ein neuer Titel wird als Vorschlag im Eintrag gespeichert; der User
  //    entscheidet selbst, ob daraus ein Vorgang wird.
  let vorgangId = analyse.vorgang_id ? parseInt(analyse.vorgang_id) : null;
  let vorgangVorschlag = null;
  if (!vorgangId && analyse.vorgang_titel) {
    const vorhanden = await queryOne(
      'SELECT id FROM vorgaenge WHERE titel LIKE ? LIMIT 1',
      [`%${analyse.vorgang_titel}%`]
    );
    if (vorhanden) {
      vorgangId = vorhanden.id;
    } else {
      vorgangVorschlag = analyse.vorgang_titel;
    }
  }

  if (!vorgangId) {
    const sammel = await queryOne(
      `SELECT id FROM vorgaenge WHERE titel = 'Diktate ohne Zuordnung' LIMIT 1`
    );
    if (sammel) {
      vorgangId = sammel.id;
    } else {
      const ncPfad = await vorgangOrdner('Diktate ohne Zuordnung').catch(() => null);
      const result = await query(
        `INSERT INTO vorgaenge (titel, typ, beschreibung, nc_ordner)
         VALUES ('Diktate ohne Zuordnung', 'sonstiges', 'Sammelvorgang für nicht zugeordnete Diktate', ?)`,
        [ncPfad]
      );
      vorgangId = result.insertId;
    }
  }

  // 4) Eintrag schreiben
  const inhalt = {
    ...neueVorschlaege,
    aufgenommen_am: aufgenommenAm || null,
    dauer_sekunden: dauerSekunden || null,
    audio_pfad: audioPfad,
    quelle,
    zusammenfassung_plaud: zusammenfassungPlaud || null,
    vorgang_vorschlag: vorgangVorschlag,
  };
  const eintragTitel = `Diktat: ${safeFilename(titel)}`;
  const result = await query(
    'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, datei_pfad) VALUES (?,?,?,?,?)',
    [vorgangId, 'notiz', eintragTitel, JSON.stringify(inhalt), audioPfad]
  );

  // 5) Pushover (best-effort)
  const offen = neueVorschlaege.aufgaben.length + neueVorschlaege.delegationen.length + neueVorschlaege.termine.length;
  try {
    const vorgang = await queryOne('SELECT titel FROM vorgaenge WHERE id = ?', [vorgangId]);
    const { pushDiktatVerarbeitet } = await import('./pushover.js');
    await pushDiktatVerarbeitet(titel, vorgang?.titel || null, analyse.zusammenfassung || '', offen);
  } catch (e) {
    console.warn('[Diktat] Push fehlgeschlagen:', e.message);
  }

  console.log(`[Diktat] "${titel}" → Vorgang #${vorgangId}, ${offen} Vorschläge, audio=${audioPfad ? 'ja' : 'nein'}, quelle=${quelle}`);
  return {
    eintragId: result.insertId,
    vorgangId,
    audioPfad,
    vorschlaege: offen,
    analyse: inhalt,
  };
}
