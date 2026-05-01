import { DAVClient } from 'tsdav';
import { getDb } from './db.js';

/**
 * Synchronisiert alle aktiven CalDAV-Kalender.
 */
export async function syncAllCalendars() {
  const db = getDb();
  const calendars = db.prepare('SELECT * FROM calendars WHERE active = 1').all();
  const results = [];

  for (const cal of calendars) {
    const start = Date.now();
    try {
      const count = await syncCalendar(cal);
      const ms = Date.now() - start;
      db.prepare(`INSERT INTO sync_log (type, account_id, status, message, duration_ms)
                  VALUES ('calendar', ?, 'ok', ?, ?)`).run(cal.id, `${count} Events aktualisiert`, ms);
      results.push({ calendar: cal.label, status: 'ok', updated: count });
    } catch (err) {
      const ms = Date.now() - start;
      db.prepare(`INSERT INTO sync_log (type, account_id, status, message, duration_ms)
                  VALUES ('calendar', ?, 'error', ?, ?)`).run(cal.id, err.message, ms);
      results.push({ calendar: cal.label, status: 'error', error: err.message });
    }
  }
  return results;
}

async function syncCalendar(cal) {
  const client = new DAVClient({
    serverUrl: cal.url,
    credentials: { username: cal.username, password: cal.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  await client.login();
  const calendars = await client.fetchCalendars();

  // Erstes Kalender-Objekt nehmen (oder URL direkt als Kalender behandeln)
  const target = calendars[0];
  if (!target) return 0;

  // Zeitfenster: 30 Tage zurück, 90 Tage voraus
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const to = new Date();
  to.setDate(to.getDate() + 90);

  const objects = await client.fetchCalendarObjects({
    calendar: target,
    timeRange: { start: from.toISOString(), end: to.toISOString() },
  });

  const db = getDb();
  let count = 0;

  for (const obj of objects) {
    const parsed = parseICalEvent(obj.data);
    if (!parsed) continue;

    db.prepare(`
      INSERT INTO events (calendar_id, uid, title, start_time, end_time, location, description, all_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(calendar_id, uid) DO UPDATE SET
        title       = excluded.title,
        start_time  = excluded.start_time,
        end_time    = excluded.end_time,
        location    = excluded.location,
        description = excluded.description,
        all_day     = excluded.all_day,
        synced_at   = datetime('now')
    `).run(
      cal.id, parsed.uid, parsed.title,
      parsed.start, parsed.end,
      parsed.location, parsed.description,
      parsed.allDay ? 1 : 0
    );
    count++;
  }

  return count;
}

/** Minimalparser für VEVENT in iCal-Format */
function parseICalEvent(icsData) {
  if (!icsData) return null;
  const get = (key) => {
    const match = icsData.match(new RegExp(`^${key}[^:]*:(.+)$`, 'm'));
    return match ? match[1].trim().replace(/\\n/g, '\n').replace(/\\,/g, ',') : null;
  };

  const uid = get('UID');
  if (!uid) return null;

  const dtstart = get('DTSTART');
  const dtend   = get('DTEND');
  const allDay  = dtstart && !dtstart.includes('T');

  return {
    uid,
    title:       get('SUMMARY')     || '(kein Titel)',
    start:       dtstart ? iCalToIso(dtstart) : null,
    end:         dtend   ? iCalToIso(dtend)   : null,
    location:    get('LOCATION')    || null,
    description: get('DESCRIPTION') || null,
    allDay,
  };
}

function iCalToIso(str) {
  // Zulu: 20240515T100000Z → ISO
  if (/^\d{8}T\d{6}Z$/.test(str)) {
    return new Date(
      str.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
        '$1-$2-$3T$4:$5:$6Z')
    ).toISOString();
  }
  // Lokaler Wert ohne TZ
  if (/^\d{8}T\d{6}$/.test(str)) {
    return str.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
      '$1-$2-$3T$4:$5:$6');
  }
  // Ganztägig: 20240515
  if (/^\d{8}$/.test(str)) {
    return str.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  }
  return str;
}

/** Liefert Kontext-String für Claude – nur zukünftige + heutige Events */
export function getCalendarContext(days = 7) {
  const db = getDb();
  const now = new Date().toISOString();
  const until = new Date();
  until.setDate(until.getDate() + days);

  const events = db.prepare(`
    SELECT e.title, e.start_time, e.end_time, e.location, e.all_day, c.label as cal_label
    FROM events e
    JOIN calendars c ON c.id = e.calendar_id
    WHERE e.start_time >= ? AND e.start_time <= ?
    ORDER BY e.start_time ASC
    LIMIT 50
  `).all(now, until.toISOString());

  if (events.length === 0) return 'Keine Termine in den nächsten 7 Tagen.';

  const lines = [`\n## Termine (nächste ${days} Tage)`];
  for (const ev of events) {
    const start = ev.start_time
      ? new Date(ev.start_time).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
      : '?';
    const loc = ev.location ? ` @ ${ev.location}` : '';
    lines.push(`- ${start}: ${ev.title}${loc} [${ev.cal_label}]`);
  }
  return lines.join('\n');
}
