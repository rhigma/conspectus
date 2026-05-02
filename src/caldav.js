import { query, queryOne } from './db.js';

/**
 * Synchronisiert alle aktiven CalDAV-Kalender.
 */
export async function syncAllCalendars() {
  const calendars = await query('SELECT * FROM calendars WHERE active = 1');
  if (!calendars.length) return [];
  const results = [];

  for (const cal of calendars) {
    const start = Date.now();
    try {
      const count = await syncCalendar(cal);
      await query(
        'INSERT INTO sync_log (type, status, message, duration_ms) VALUES (?,?,?,?)',
        ['calendar', 'ok', `${cal.label}: ${count} Events`, Date.now() - start]
      );
      results.push({ calendar: cal.label, status: 'ok', updated: count });
    } catch (err) {
      await query(
        'INSERT INTO sync_log (type, status, message, duration_ms) VALUES (?,?,?,?)',
        ['calendar', 'error', `${cal.label}: ${err.message}`, Date.now() - start]
      );
      results.push({ calendar: cal.label, status: 'error', error: err.message });
    }
  }
  return results;
}

async function syncCalendar(cal) {
  // CalDAV REPORT request
  const auth = 'Basic ' + Buffer.from(`${cal.username}:${cal.password}`).toString('base64');

  // Zeitfenster: 60 Tage zurück, 180 Tage voraus
  const from = new Date();
  from.setDate(from.getDate() - 60);
  const to = new Date();
  to.setDate(to.getDate() + 180);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${formatIcal(from)}" end="${formatIcal(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const { default: fetch } = await import('node-fetch');
  const res = await fetch(cal.url, {
    method: 'REPORT',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: '1',
    },
    body,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();

  // iCal-Daten aus REPORT-Response extrahieren
  const icalBlocks = [...xml.matchAll(/<[^:]+:calendar-data[^>]*>([\s\S]*?)<\/[^:]+:calendar-data>/g)]
    .map(m => m[1].trim());

  let count = 0;
  for (const ical of icalBlocks) {
    const event = parseVEvent(ical);
    if (!event) continue;

    await query(`
      INSERT INTO events (calendar_id, uid, title, start_time, end_time, location, description, all_day)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        title       = VALUES(title),
        start_time  = VALUES(start_time),
        end_time    = VALUES(end_time),
        location    = VALUES(location),
        description = VALUES(description),
        all_day     = VALUES(all_day),
        synced_at   = NOW()
    `, [
      cal.id, event.uid, event.title,
      event.start, event.end,
      event.location, event.description,
      event.allDay ? 1 : 0,
    ]);
    count++;
  }
  return count;
}

function formatIcal(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function parseVEvent(ical) {
  // Nur den VEVENT-Block extrahieren
  const veventMatch = ical.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/);
  if (veventMatch) ical = veventMatch[0];
  const get = (key) => {
    const m = ical.match(new RegExp(`^${key}[^:;]*[:;][^\r\n]*[:][^\r\n]+|^${key}:[^\r\n]+`, 'm'));
    if (!m) return null;
    // Wert nach letztem Doppelpunkt
    const val = m[0].replace(/^[^:]+:/, '').trim();
    // Zeilenfortsetzungen entfalten
    return val.replace(/\r?\n[ \t]/g, '').replace(/\\n/g, '\n').replace(/\\,/g, ',');
  };

  const uid = get('UID');
  if (!uid) return null;

  const getTzid = (key) => {
    const m = ical.match(new RegExp(`^${key};TZID=([^:]+):(\\d{8}T\\d{6})`, 'm'));
    return m ? { tzid: m[1].trim(), dt: m[2].trim() } : null;
  };

  const dtstartRaw = getTzid('DTSTART');
  const dtendRaw   = getTzid('DTEND');
  const dtstart = dtstartRaw?.dt || get('DTSTART');
  const dtend   = dtendRaw?.dt   || get('DTEND') || get('DURATION');
  const tzid    = dtstartRaw?.tzid || null;
  const allDay  = dtstart && !dtstart.includes('T');

  return {
    uid,
    title:       get('SUMMARY')     || '(kein Titel)',
    start:       dtstart ? icalToIso(dtstart, tzid) : null,
    end:         dtend   ? icalToIso(dtend,   tzid) : null,
    location:    get('LOCATION')    || null,
    description: get('DESCRIPTION') || null,
    allDay,
  };
}

function icalToIso(str, tzid) {
  if (!str) return null;
  // Mit Z = UTC
  if (/^\d{8}T\d{6}Z$/.test(str))
    return str.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z');
  // Lokale Zeit mit bekannter Zeitzone
  if (/^\d{8}T\d{6}$/.test(str)) {
    const iso = str.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6');
    const month = parseInt(str.slice(4,6));
    const isSummer = month >= 3 && month <= 10;
    // Alle bekannten europäischen Zeitzonen → Berlin-Offset
    const isBerlin = !tzid || tzid.includes('Berlin') || tzid.includes('Europe') || 
                     tzid.includes('W. Europe') || tzid.includes('Central Europe');
    if (isBerlin) {
      const offset = isSummer ? '+02:00' : '+01:00';
      return new Date(iso + offset).toISOString();
    }
    // Unbekannte Zeitzone – als UTC behandeln
    return new Date(iso + 'Z').toISOString();
  }
  // Ganztägig
  if (/^\d{8}$/.test(str))
    return str.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  return str;
}

export async function getCalendarContext(days = 7) {
  const now = new Date().toISOString();
  const until = new Date();
  until.setDate(until.getDate() + days);

  const events = await query(`
    SELECT e.title, e.start_time, e.end_time, e.location, e.all_day, c.label as cal_label
    FROM events e
    JOIN calendars c ON c.id = e.calendar_id
    WHERE e.start_time >= ? AND e.start_time <= ?
    ORDER BY e.start_time ASC
    LIMIT 50
  `, [now, until.toISOString()]);

  if (!events.length) return '\n## Kalender\nKeine Termine in den nächsten 7 Tagen.';

  const lines = ['\n## Termine (nächste 7 Tage)'];
  for (const ev of events) {
    const dt = ev.start_time
      ? new Date(ev.start_time).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
      : '?';
    const loc = ev.location ? ` @ ${ev.location}` : '';
    lines.push(`- ${dt}: ${ev.title}${loc} [${ev.cal_label}]`);
  }
  return lines.join('\n');
}

export async function createCalDavEvent(calendarId, { uid, title, start, end, description }) {
  const cal = await queryOne('SELECT * FROM calendars WHERE id = ?', [calendarId]);
  if (!cal) throw new Error('Kalender nicht gefunden');
  const auth = 'Basic ' + Buffer.from(`${cal.username}:${cal.password}`).toString('base64');
  const { default: fetch } = await import('node-fetch');

  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 3600000);

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Conspectus//DE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcal(new Date())}`,
    `DTSTART;TZID=Europe/Berlin:${formatIcalLocal(startDate)}`,
    `DTEND;TZID=Europe/Berlin:${formatIcalLocal(endDate)}`,
    `SUMMARY:${escapeIcal(title)}`,
    description ? `DESCRIPTION:${escapeIcal(description)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  const base = cal.url.endsWith('/') ? cal.url : cal.url + '/';
  const res = await fetch(base + uid + '.ics', {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'text/calendar; charset=utf-8' },
    body: ics,
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`CalDAV PUT fehlgeschlagen: HTTP ${res.status}`);
  }
}

export async function deleteCalDavEvent(calendarId, uid) {
  const cal = await queryOne('SELECT * FROM calendars WHERE id = ?', [calendarId]);
  if (!cal) return;
  const auth = 'Basic ' + Buffer.from(`${cal.username}:${cal.password}`).toString('base64');
  const { default: fetch } = await import('node-fetch');
  const base = cal.url.endsWith('/') ? cal.url : cal.url + '/';
  const res = await fetch(base + uid + '.ics', {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  if (!res.ok && res.status !== 404 && res.status !== 204) {
    throw new Error(`CalDAV DELETE fehlgeschlagen: HTTP ${res.status}`);
  }
}

function formatIcalLocal(date) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

function escapeIcal(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

export async function testCalDav(url, username, password) {
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: '0', 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const name = xml.match(/<d:displayname>([^<]*)<\/d:displayname>/)?.[1] || url.split('/').filter(Boolean).pop();
  return { ok: true, name };
}
