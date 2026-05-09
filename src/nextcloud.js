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

// ── Ordner-Basis-Konstanten ───────────────────────────────────────────────
// Eigener Top-Level-Ordner /Conspectus/, damit es keine Kollision mit z.B.
// Nextcloud Mail (das selbst /E-Mail-Anhänge/ verwenden kann) gibt.
export const NC_BASIS = '/Conspectus';
export const NC_VORGAENGE_BASIS = `${NC_BASIS}/Vorgaenge`;
export const NC_EMAIL_ANHAENGE_BASIS = `${NC_BASIS}/E-Mail-Anhänge`;

// ── Ordner für Vorgang anlegen ─────────────────────────────────────────────

export async function vorgangOrdner(titel) {
  const safe = titel.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80);
  const path = `${NC_VORGAENGE_BASIS}/${safe}`;
  try {
    await ncMkdir(NC_BASIS);
    await ncMkdir(NC_VORGAENGE_BASIS);
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

// E-Mail-Anhänge nach /Conspectus/E-Mail-Anhänge/<JJJJ>/<MM>/<account-uid>_<datei>
// ablegen. Datum-Buckets halten den Ordner schlank; das account-uid-Präfix
// verhindert Kollisionen bei gleichnamigen Anhängen aus verschiedenen Mails.
export async function speichereEmailAnhang(emailDate, accountId, uid, dateiname, buffer, mimeType) {
  const d = emailDate ? new Date(emailDate) : new Date();
  const jahr = String(d.getFullYear());
  const monat = String(d.getMonth() + 1).padStart(2, '0');
  const safe = (dateiname || 'anhang').replace(/[\/\\:*?"<>|]/g, '_');
  const ordner = `${NC_EMAIL_ANHAENGE_BASIS}/${jahr}/${monat}`;
  const path = `${ordner}/${accountId}-${uid}_${safe}`;
  try {
    await ncMkdir(NC_BASIS);
    await ncMkdir(NC_EMAIL_ANHAENGE_BASIS);
    await ncMkdir(`${NC_EMAIL_ANHAENGE_BASIS}/${jahr}`);
    await ncMkdir(ordner);
    await ncUpload(path, buffer, mimeType);
  } catch (e) {
    console.warn('[NC] E-Mail-Anhang speichern:', e.message);
  }
  return path;
}

// WebDAV MOVE — ignoriert 404 (Quelle existiert nicht mehr). Gibt true bei Erfolg.
export async function ncMove(srcPath, destPath, { overwrite = false } = {}) {
  const enc = p => p.split('/').map(s => encodeURIComponent(s)).join('/');
  const url  = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${enc(srcPath)}`;
  const dest = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${enc(destPath)}`;
  const res = await fetch(url, {
    method: 'MOVE',
    headers: { Authorization: authHeader(), Destination: dest, Overwrite: overwrite ? 'T' : 'F' },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`MOVE ${srcPath} → ${destPath}: HTTP ${res.status}`);
  return true;
}

// Verschiebt alle Anhänge einer E-Mail in den Anhänge-Unterordner ihres Vorgangs.
// Best-effort: schlägt eine Datei fehl, bleibt sie am alten Ort und ihr Pfad in
// der DB unverändert. Liefert die aktualisierte Anhang-Liste oder null, wenn
// nichts zu tun war.
export async function moveEmailAnhaengeZuVorgang(anhangListe, vorgangNcOrdner) {
  if (!Array.isArray(anhangListe) || !anhangListe.length || !vorgangNcOrdner) return null;
  const ziel = `${vorgangNcOrdner}/Anhänge`;
  let dirty = false;
  try { await ncMkdir(vorgangNcOrdner); } catch (_) {}
  try { await ncMkdir(ziel); } catch (_) {}
  for (let i = 0; i < anhangListe.length; i++) {
    const a = anhangListe[i];
    if (!a?.pfad) continue;
    if (a.pfad.startsWith(ziel + '/')) continue;          // schon am Ziel
    const dateiname = a.pfad.split('/').pop();
    const neuerPfad = `${ziel}/${dateiname}`;
    try {
      const ok = await ncMove(a.pfad, neuerPfad);
      if (ok) {
        anhangListe[i] = { ...a, pfad: neuerPfad };
        dirty = true;
      }
    } catch (e) {
      console.warn(`[NC-Move] ${a.pfad} → ${neuerPfad}: ${e.message}`);
    }
  }
  return dirty ? anhangListe : null;
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

// Standard-Zielpfad ableiten, wenn kein expliziter Ziel-Ordner gesetzt ist.
export function defaultZielOrdner(quelle) {
  const norm = quelle.replace(/\/+$/, '');
  return norm + '_verarbeitet';
}

export async function neueBooxNotizen(quellOrdner = BOOX_PFAD) {
  try {
    const dateien = await ncList(quellOrdner);
    return dateien
      .filter(p => p.toLowerCase().endsWith('.pdf'))
      .map(p => {
        // Vollen DAV-Pfad auf relativen Pfad kürzen
        const marker = `/files/${NC_USER()}`;
        const idx = p.indexOf(marker);
        return idx >= 0 ? p.slice(idx + marker.length) : p;
      });
  } catch (e) {
    console.warn('[Boox] Ordner nicht lesbar:', quellOrdner, '–', e.message);
    return [];
  }
}

export async function booxVerarbeitet(pfad, zielOrdner) {
  const ziel_basis = zielOrdner || BOOX_VERARBEITET;
  const dateiname = pfad.split('/').pop();
  // Zeitstempel zwischen Stamm und Endung einfügen, damit Re-Syncs derselben
  // Notiz nicht stumm überschreiben: "Studientag.pdf" → "Studientag.2026-05-07T2318.pdf"
  const dot = dateiname.lastIndexOf('.');
  const stamm = dot > 0 ? dateiname.slice(0, dot) : dateiname;
  const ext = dot > 0 ? dateiname.slice(dot) : '';
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '');
  // → 20260507T2318
  const stamp = `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(9,13)}`;
  const versioniert = `${stamm}.${stamp}${ext}`;
  const ziel = `${ziel_basis}/${versioniert}`;
  try {
    await ncMkdir(ziel_basis);
    // Pfad-Segmente einzeln enkodieren (Umlaute!)
    const encPfad = pfad.split('/').map(s => encodeURIComponent(s)).join('/');
    const encZiel = ziel.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${encPfad}`;
    const dest = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${encZiel}`;
    const res = await fetch(url, {
      method: 'MOVE',
      headers: { Authorization: authHeader(), Destination: dest, Overwrite: 'F' },
    });
    if (!res.ok) console.warn('[Boox] MOVE HTTP', res.status, await res.text());
    return res.ok;
  } catch(e) {
    console.warn('[Boox] Verschieben fehlgeschlagen:', e.message);
    return false;
  }
}

// ── DIKTAT-AUDIO ─────────────────────────────────────────────────────────────
// MP3s landen im Format /Diktate/<YYYY>/<YYYY-MM-DD>_<safe-titel>.mp3
export const DIKTAT_BASIS_PFAD = '/Diktate';

function safeFilenameStamm(titel) {
  return (titel || 'diktat')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'diktat';
}

export async function speichereDiktatAudio(buffer, titel, aufgenommenAm, basisPfad = DIKTAT_BASIS_PFAD) {
  const datum = aufgenommenAm ? new Date(aufgenommenAm) : new Date();
  const jahr = String(datum.getFullYear());
  const datumStr = datum.toISOString().slice(0, 10);
  const stamm = safeFilenameStamm(titel);
  const dateiname = `${datumStr}_${stamm}.mp3`;
  const jahrPfad = `${basisPfad}/${jahr}`;
  const zielPfad = `${jahrPfad}/${dateiname}`;

  await ncMkdir(basisPfad).catch(e => console.warn('[Diktat] mkdir basis:', e.message));
  await ncMkdir(jahrPfad).catch(e => console.warn('[Diktat] mkdir jahr:', e.message));
  await ncUpload(zielPfad, buffer, 'audio/mpeg');
  return zielPfad;
}

// ── ROCKETBOOK-PDF ───────────────────────────────────────────────────────────
// Rocketbook-Scans landen im Format /Conspectus/Rocketbook/<YYYY>/<YYYY-MM-DD>_<safe-titel>.pdf
export const ROCKETBOOK_BASIS_PFAD = `${NC_BASIS}/Rocketbook`;

export async function speichereRocketbookPdf(buffer, titel, empfangenAm, basisPfad = ROCKETBOOK_BASIS_PFAD) {
  const datum = empfangenAm ? new Date(empfangenAm) : new Date();
  const jahr = String(datum.getFullYear());
  const datumStr = datum.toISOString().slice(0, 10);
  const stamm = safeFilenameStamm(titel);
  const dateiname = `${datumStr}_${stamm}.pdf`;
  const jahrPfad = `${basisPfad}/${jahr}`;
  const zielPfad = `${jahrPfad}/${dateiname}`;

  await ncMkdir(NC_BASIS).catch(() => {});
  await ncMkdir(basisPfad).catch(e => console.warn('[Rocketbook] mkdir basis:', e.message));
  await ncMkdir(jahrPfad).catch(e => console.warn('[Rocketbook] mkdir jahr:', e.message));
  await ncUpload(zielPfad, buffer, 'application/pdf');
  return zielPfad;
}

// Existenz-Prüfung eines Ordners auf Nextcloud (HEAD/PROPFIND).
export async function ncOrdnerExistiert(pfad) {
  try {
    const encPath = pfad.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `${NC_URL()}/remote.php/dav/files/${NC_USER()}${encPath}`;
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: { Authorization: authHeader(), Depth: '0' },
    });
    return res.ok || res.status === 207;
  } catch (_) {
    return false;
  }
}
