import fetch from 'node-fetch';

const NC_URL  = () => process.env.NC_URL.replace(/\/$/, '');
const NC_USER = () => process.env.NC_USER;
const NC_PASS = () => process.env.NC_PASS;

function authHeader() {
  return 'Basic ' + Buffer.from(`${NC_USER()}:${NC_PASS()}`).toString('base64');
}

// ── WebDAV ────────────────────────────────────────────────────────────────────

export async function ncMkdir(path) {
  const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${path}`;
  const res = await fetch(url, { method: 'MKCOL', headers: { Authorization: authHeader() } });
  // 201 = created, 405 = already exists – beide OK
  if (res.status !== 201 && res.status !== 405) {
    throw new Error(`MKCOL ${path} → HTTP ${res.status}`);
  }
}

export async function ncUpload(path, buffer, mimeType = 'application/octet-stream') {
  const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: authHeader(), 'Content-Type': mimeType },
    body: buffer,
  });
  if (res.status !== 201 && res.status !== 204) {
    throw new Error(`PUT ${path} → HTTP ${res.status}`);
  }
  return path;
}

export async function ncDownload(path) {
  const encPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
  const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${encPath}`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function ncList(path) {
  const encPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
  const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${encPath}`;
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(),
      Depth: '1',
      'Content-Type': 'application/xml',
    },
    body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:displayname/><d:getcontenttype/><d:getlastmodified/><d:getcontentlength/></d:prop>
</d:propfind>`,
  });
  if (!res.ok) throw new Error(`PROPFIND ${path} → HTTP ${res.status}`);
  const xml = await res.text();
  // Einfacher Parse: Dateinamen extrahieren
  const matches = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)];
  return matches
    .map(m => decodeURIComponent(m[1]))
    .filter(p => !p.endsWith(path) && !p.endsWith(path + '/'));
}

// ── Ordner für Vorgang anlegen ─────────────────────────────────────────────

export async function vorgangOrdner(titel) {
  const safe = titel.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80);
  const base = '/Vorgaenge';
  const path = `${base}/${safe}`;
  try {
    await ncMkdir(base);
    await ncMkdir(path);
  } catch (e) {
    console.warn('[NC] Ordner anlegen:', e.message);
  }
  return path;
}

// ── Anhang speichern ───────────────────────────────────────────────────────

export async function speichereAnhang(vorgangOrdnerPfad, dateiname, buffer, mimeType) {
  const safe = dateiname.replace(/[\/\\:*?"<>|]/g, '_');
  const path = `${vorgangOrdnerPfad}/Anhänge/${safe}`;
  try {
    await ncMkdir(`${vorgangOrdnerPfad}/Anhänge`);
    await ncUpload(path, buffer, mimeType);
  } catch (e) {
    console.warn('[NC] Anhang speichern:', e.message);
  }
  return path;
}

// ── Nextcloud Tasks (VTODO via CalDAV) ────────────────────────────────────

export async function taskAnlegen({ titel, beschreibung, faellig, vorgang }) {
  // Tasks landen im Standard-Aufgabenkalender
  const uid = `ki-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const due = faellig ? new Date(faellig).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z' : null;

  const vtodo = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KI-Assistent//DE',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${titel}`,
    beschreibung ? `DESCRIPTION:${beschreibung.replace(/\n/g, '\\n')}` : '',
    due ? `DUE:${due}` : '',
    vorgang ? `CATEGORIES:${vorgang}` : '',
    'STATUS:NEEDS-ACTION',
    'END:VTODO',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  const url = `${NC_URL()}/remote.php/dav/calendars/${NC_USER()}/tasks/${uid}.ics`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'text/calendar; charset=utf-8',
    },
    body: vtodo,
  });

  if (res.status !== 201 && res.status !== 204) {
    console.warn('[NC Tasks] HTTP', res.status);
    return null;
  }
  return uid;
}

// ── reMarkable-Monitoring ─────────────────────────────────────────────────

export async function neueRemarkableNotizen() {
  try {
    const dateien = await ncList('/reMarkable/neu');
    return dateien.filter(p => p.endsWith('.pdf') || p.endsWith('.png'));
  } catch (e) {
    return [];
  }
}

export async function remarkableVerarbeitet(path) {
  // Datei von /reMarkable/neu/ nach /reMarkable/verarbeitet/ verschieben
  const dateiname = path.split('/').pop();
  const ziel = `/reMarkable/verarbeitet/${dateiname}`;
  const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${path}`;
  const res = await fetch(url, {
    method: 'MOVE',
    headers: {
      Authorization: authHeader(),
      Destination: `${NC_URL()}/remote.php/dav/files/${NC_USER()}${ziel}`,
      Overwrite: 'T',
    },
  });
  return res.ok;
}

// ── BOOX SYNC ─────────────────────────────────────────────────────────────────
export const BOOX_PFAD = '/onyx/GoColor7_2/Notizblöcke';
export const BOOX_VERARBEITET = '/onyx/GoColor7_2/Notizblöcke_verarbeitet';

export async function neueBooxNotizen() {
  try {
    const dateien = await ncList(BOOX_PFAD);
    return dateien
      .filter(p => p.toLowerCase().endsWith('.pdf'))
      .map(p => {
        // Vollen DAV-Pfad auf relativen Pfad kürzen
        const marker = `/files/${NC_USER()}`;
        const idx = p.indexOf(marker);
        return idx >= 0 ? p.slice(idx + marker.length) : p;
      });
  } catch (e) {
    console.warn('[Boox] Ordner nicht lesbar:', e.message);
    return [];
  }
}

export async function booxVerarbeitet(pfad) {
  const dateiname = pfad.split('/').pop();
  const ziel = `${BOOX_VERARBEITET}/${dateiname}`;
  try {
    await ncMkdir(BOOX_VERARBEITET);
    // Pfad-Segmente einzeln enkodieren (Umlaute!)
    const encPfad = pfad.split('/').map(s => encodeURIComponent(s)).join('/');
    const encZiel = ziel.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${encPfad}`;
    const dest = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${encZiel}`;
    const res = await fetch(url, {
      method: 'MOVE',
      headers: { Authorization: authHeader(), Destination: dest, Overwrite: 'T' },
    });
    if (!res.ok) console.warn('[Boox] MOVE HTTP', res.status, await res.text());
    return res.ok;
  } catch(e) {
    console.warn('[Boox] Verschieben fehlgeschlagen:', e.message);
    return false;
  }
}
