import fetch from 'node-fetch';
import { queryOne } from './db.js';

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

async function getCredentials() {
  const [tokenRow, userRow] = await Promise.all([
    queryOne("SELECT value FROM settings WHERE `key` = 'pushover_token'"),
    queryOne("SELECT value FROM settings WHERE `key` = 'pushover_user'"),
  ]);
  return {
    token: tokenRow?.value || process.env.PUSHOVER_TOKEN,
    user:  userRow?.value  || process.env.PUSHOVER_USER,
  };
}

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
    const { token, user } = await getCredentials();
    if (!token || !user) throw new Error('Pushover-Zugangsdaten fehlen (Token + User Key in Einstellungen konfigurieren)');
    const body = new URLSearchParams({
      token,
      user,
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

export async function pushDiktatVerarbeitet(titel, vorgangTitel, zusammenfassung, offen) {
  const zeilen = [
    vorgangTitel ? `Vorgang: ${vorgangTitel}` : 'Kein Vorgang zugeordnet',
    offen ? `${offen} Vorschläge offen` : '',
    zusammenfassung ? zusammenfassung.slice(0, 180) : '',
  ].filter(Boolean);
  return push(`🎙 Diktat: ${titel}`, zeilen.join('\n'), {
    url: process.env.APP_URL || '',
    url_title: 'Ansehen',
  });
}

export async function pushRocketbookVerarbeitet(titel, vorgangTitel, zusammenfassung, offen) {
  const zeilen = [
    vorgangTitel ? `Vorgang: ${vorgangTitel}` : 'Kein Vorgang zugeordnet',
    offen ? `${offen} Vorschläge offen` : '',
    zusammenfassung ? zusammenfassung.slice(0, 180) : '',
  ].filter(Boolean);
  return push(`📓 Rocketbook: ${titel}`, zeilen.join('\n'), {
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

export async function pushTodosFaellig(todos) {
  if (!todos.length) return { ok: true, skipped: true };
  const faellig = todos.filter(t => {
    const d = new Date(t.faellig_am);
    const heute = new Date(); heute.setHours(0,0,0,0);
    return d < heute;
  });
  const heute = todos.filter(t => {
    const d = new Date(t.faellig_am);
    const h = new Date(); h.setHours(0,0,0,0);
    const morgen = new Date(h); morgen.setDate(h.getDate() + 1);
    return d >= h && d < morgen;
  });
  const zeilen = [];
  if (faellig.length) zeilen.push(`⚠ Überfällig (${faellig.length}): ${faellig.map(t => t.titel).join(', ')}`);
  if (heute.length)   zeilen.push(`📌 Heute fällig (${heute.length}): ${heute.map(t => t.titel).join(', ')}`);
  return push(
    `✅ Todo-Erinnerung (${todos.length})`,
    zeilen.join('\n').slice(0, 1024),
    { url: process.env.APP_URL || '', url_title: 'Öffnen' }
  );
}

export async function pushTest() {
  return push(
    'KI-Assistent',
    'Pushover-Verbindung erfolgreich eingerichtet ✓',
    { sound: 'magic' }
  );
}
