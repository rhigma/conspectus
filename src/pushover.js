import fetch from 'node-fetch';

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

const TOKEN = () => process.env.PUSHOVER_TOKEN;
const USER  = () => process.env.PUSHOVER_USER;

/**
 * Sendet eine Pushover-Benachrichtigung.
 * @param {string} title   - Titel
 * @param {string} message - Nachrichtentext
 * @param {object} opts    - Optionale Parameter
 * @param {number} opts.priority  - -2 bis 2 (Standard: 0)
 * @param {string} opts.sound     - Pushover-Sound
 * @param {string} opts.url       - Optionaler Link
 * @param {string} opts.url_title - Link-Beschriftung
 */
export async function push(title, message, opts = {}) {
  try {
    const body = new URLSearchParams({
      token:   TOKEN(),
      user:    USER(),
      title:   title.slice(0, 250),
      message: message.slice(0, 1024),
      priority: String(opts.priority ?? 0),
      ...(opts.sound     ? { sound: opts.sound }         : {}),
      ...(opts.url       ? { url: opts.url }             : {}),
      ...(opts.url_title ? { url_title: opts.url_title } : {}),
    });

    const res = await fetch(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.status !== 1) throw new Error(data.errors?.join(', ') || 'Pushover-Fehler');
    return { ok: true, request: data.request };
  } catch (e) {
    console.error('[Pushover] Fehler:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Vordefinierte Benachrichtigungstypen ──────────────────────────────────────

export async function pushBriefing(text) {
  // Briefing-Text auf 1000 Zeichen kürzen
  const short = text.replace(/\*\*/g, '').slice(0, 1000);
  return push('☀ Morgen-Briefing', short, {
    sound: 'magic',
    url: process.env.APP_URL || '',
    url_title: 'Assistent öffnen',
  });
}

export async function pushNeueEmail(from, subject, vorgangTitel) {
  const msg = vorgangTitel
    ? `Vorgang: ${vorgangTitel}\nVon: ${from}`
    : `Von: ${from}`;
  return push(`✉ ${subject.slice(0, 80)}`, msg, {
    url: process.env.APP_URL || '',
    url_title: 'Öffnen',
  });
}

export async function pushDelegationFaellig(aufgabe, anName, vorgangTitel) {
  return push(
    `⚠ Delegation überfällig`,
    `${anName}: ${aufgabe}\nVorgang: ${vorgangTitel}`,
    { priority: 1, sound: 'siren' }
  );
}

export async function pushBooxVerarbeitet(dateiname, vorgangTitel, zusammenfassung) {
  const msg = [
    vorgangTitel ? `Vorgang: ${vorgangTitel}` : 'Kein Vorgang zugeordnet',
    zusammenfassung ? zusammenfassung.slice(0, 200) : '',
  ].filter(Boolean).join('\n');
  return push(`✎ Boox-Notiz: ${dateiname}`, msg, {
    url: process.env.APP_URL || '',
    url_title: 'Ansehen',
  });
}

export async function pushTerminErinnerung(titel, startTime, location) {
  const dt = new Date(startTime).toLocaleString('de-DE', {
    weekday: 'short', hour: '2-digit', minute: '2-digit'
  });
  const msg = location ? `${dt} @ ${location}` : dt;
  return push(`◷ Termin in 30 Min.`, `${titel}\n${msg}`, {
    sound: 'bugle',
    priority: 1,
  });
}

export async function pushTest() {
  return push(
    'KI-Assistent',
    'Pushover-Verbindung erfolgreich eingerichtet ✓',
    { sound: 'magic' }
  );
}
