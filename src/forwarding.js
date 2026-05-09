import { queryOne } from './db.js';

// Setting-Key: Newline-getrennte Liste von Substring-Matches gegen die
// Absender-Adresse (case-insensitiv). Eine Mail von einer dieser Adressen
// wird als Weiterleitung behandelt — Wrapper + Signatur werden entfernt
// und der ursprüngliche Absender/Betreff/Datum aus dem Body extrahiert.
export const FORWARDING_SETTING = 'forwarding_trusted_senders';

export async function getForwardingPatterns() {
  const row = await queryOne(
    'SELECT value FROM settings WHERE `key` = ?',
    [FORWARDING_SETTING]
  );
  return (row?.value || '')
    .split(/\r?\n/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isTrustedForwarder(fromEmail, patterns) {
  if (!fromEmail || !patterns?.length) return false;
  const f = fromEmail.toLowerCase();
  return patterns.some(p => f.includes(p));
}

const FWD_MARKERS = [
  /^-{3,}\s*(Forwarded message|Weitergeleitete Nachricht)\s*-{3,}\s*$/i,
  /^_{3,}\s*$/,
  /^Begin forwarded message:?\s*$/i,
  /^Beginn der weitergeleiteten Nachricht:?\s*$/i,
];

const HEADER_KEYS = {
  from:    /^(From|Von|Absender|Sender)$/i,
  date:    /^(Date|Datum|Sent|Gesendet)$/i,
  subject: /^(Subject|Betreff)$/i,
  to:      /^(To|An)$/i,
  cc:      /^(Cc|Kopie)$/i,
  bcc:     /^(Bcc|Blindkopie)$/i,
  replyto: /^(Reply-To|Antwort an|Antwort-An)$/i,
};

function classifyHeaderKey(key) {
  for (const [name, re] of Object.entries(HEADER_KEYS)) {
    if (re.test(key)) return name;
  }
  return null;
}

function parseFromField(raw) {
  if (!raw) return { name: null, email: null };
  // "Vorname Nachname" <addr@example.com>  /  Vorname Nachname <addr@…>  /  addr@…
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<?([^\s<>"]+@[^\s<>"]+?)>?\s*$/);
  if (!m) return { name: null, email: null };
  const name = (m[1] || '').trim() || null;
  const email = m[2].trim().toLowerCase();
  return { name, email };
}

function parseDateLoose(raw) {
  if (!raw) return null;
  // RFC-Style funktioniert direkt; deutsche Formate scheitern → wir akzeptieren
  // den Fall und überlassen das Original-Empfangsdatum als Fallback (siehe Aufrufer).
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  return null;
}

// Liefert { fromEmail, fromName, subject, date, body } oder null,
// wenn keine plausible Weiterleitung erkannt wurde.
export function parseForwardedEmail(bodyText) {
  if (!bodyText) return null;
  const lines = String(bodyText).replace(/\r\n/g, '\n').split('\n');

  // 1) Header-Block-Beginn finden: explizite Marker-Zeile ODER frühe „Von:"-Zeile.
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (FWD_MARKERS.some(re => re.test(lines[k].trim()))) {
      i = k + 1;
      break;
    }
  }
  if (i === -1) {
    let nonEmpty = 0;
    for (let k = 0; k < lines.length && nonEmpty < 6; k++) {
      const l = lines[k].trim();
      if (!l) continue;
      nonEmpty++;
      if (/^(Von|From)\s*:/i.test(l)) { i = k; break; }
    }
  }
  if (i === -1) return null;

  // 2) Header parsen — leere Zeilen direkt nach dem Marker überspringen.
  while (i < lines.length && !lines[i].trim()) i++;
  const headers = {};
  let bodyStart = lines.length;
  while (i < lines.length) {
    const raw = lines[i];
    const l = raw.trim();
    if (!l) { bodyStart = i + 1; break; }
    // Header-Format „Key: value" — Keys sind kurz und enthalten keine Doppelpunkte
    const m = l.match(/^([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß \-]{0,20})\s*:\s*(.+)$/);
    if (!m) { bodyStart = i; break; }
    const cls = classifyHeaderKey(m[1].trim());
    if (!cls) { bodyStart = i; break; }
    headers[cls] = m[2].trim();
    i++;
  }

  if (!headers.from) return null;
  const { name: fromName, email: fromEmail } = parseFromField(headers.from);
  if (!fromEmail) return null;

  // 3) Body extrahieren + bekannte Footer/Signaturen abschneiden.
  let body = lines.slice(bodyStart).join('\n').trim();
  body = body
    .replace(/\n--\s*\n[\s\S]*$/, '')                                // Standard "-- " Signatur
    .replace(/\n_{4,}\s*\n[\s\S]*$/, '')                             // Outlook-Trenner
    .replace(/\n+\s*(Von meinem (iPhone|iPad|Android|Smartphone)|Sent from my (iPhone|iPad|Android))[\s\S]*$/i, '')
    .trim();

  return {
    fromEmail,
    fromName,
    subject: headers.subject || null,
    date: parseDateLoose(headers.date),
    body,
  };
}
