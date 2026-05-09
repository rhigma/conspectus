import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import { initSchema, query, queryOne } from './db.js';
import { syncAllAccounts, moveToErledigt, syncErledigtStatus, vorgangFolderPath, renameVorgangFolderOnAllAccounts } from './imap.js';
import { chat, executeAction, getTokenStats, emailEinordnen, notizAnalysieren, morgenbriefing, naturalSearchQuery } from './ai.js';
import { ncMkdir, neueBooxNotizen, booxVerarbeitet, ncDownload, vorgangOrdner, defaultZielOrdner, ncOrdnerExistiert, BOOX_PFAD, BOOX_VERARBEITET } from './nextcloud.js';
import { createCalDavEvent, deleteCalDavEvent } from './caldav.js';
import { diktatVerarbeiten } from './diktate.js';
import { randomUUID, randomBytes, timingSafeEqual } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const PORT   = process.env.PORT || 3001;
let   CURRENT_SECRET = process.env.API_SECRET || '';

app.use(cors({ origin: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  // /diktate validiert sein eigenes Webhook-Secret weiter unten
  if (req.path === '/diktate' && req.method === 'POST') return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (CURRENT_SECRET && key !== CURRENT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── VORGÄNGE ──────────────────────────────────────────────────────────────────
app.get('/vorgaenge', async (req, res) => {
  try {
    const { status, typ, q } = req.query;
    let sql = `
      SELECT v.*,
        (SELECT COUNT(*) FROM delegationen d WHERE d.vorgang_id = v.id AND d.status = 'offen') as offene_delegationen,
        (SELECT COUNT(*) FROM vorgang_eintraege e WHERE e.vorgang_id = v.id) as eintraege_anzahl,
        (SELECT MAX(e.created_at) FROM vorgang_eintraege e WHERE e.vorgang_id = v.id) as letzter_eintrag
      FROM vorgaenge v WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND v.status = ?'; params.push(status); }
    if (typ)    { sql += ' AND v.typ = ?'; params.push(typ); }
    if (q)      { sql += ' AND MATCH(v.titel, v.beschreibung) AGAINST(? IN BOOLEAN MODE)'; params.push(q + '*'); }
    sql += ' ORDER BY v.prioritaet ASC, v.deadline ASC, v.updated_at DESC LIMIT 100';
    res.json(await query(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/vorgaenge', async (req, res) => {
  try {
    const { titel, typ, prioritaet, deadline, beschreibung } = req.body;
    const ncPfad = await vorgangOrdner(titel);
    const result = await query(
      'INSERT INTO vorgaenge (titel, typ, prioritaet, deadline, beschreibung, nc_ordner) VALUES (?,?,?,?,?,?)',
      [titel, typ || 'sonstiges', prioritaet || 2, deadline || null, beschreibung || null, ncPfad]
    );
    res.json({ id: result.insertId, nc_ordner: ncPfad });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/vorgaenge/:id', async (req, res) => {
  try {
    const v = await queryOne('SELECT * FROM vorgaenge WHERE id = ?', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'Nicht gefunden' });

    const [eintraege, delegationen, emails, termine] = await Promise.all([
      query('SELECT * FROM vorgang_eintraege WHERE vorgang_id = ? ORDER BY created_at ASC', [req.params.id]),
      query('SELECT * FROM delegationen WHERE vorgang_id = ? ORDER BY created_at ASC', [req.params.id]),
      query('SELECT id, from_name, from_email, subject, date, unread, body_text, anhang_pfade FROM emails WHERE vorgang_id = ? ORDER BY date DESC', [req.params.id]),
      query('SELECT * FROM events WHERE vorgang_id = ? ORDER BY start_time ASC', [req.params.id]),
    ]);

    res.json({ ...v, eintraege, delegationen, emails, termine });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/vorgaenge/:id/eintraege', async (req, res) => {
  try {
    const { typ, titel, inhalt } = req.body;
    const result = await query(
      'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt) VALUES (?,?,?,?)',
      [req.params.id, typ || 'notiz', titel, inhalt || null]
    );
    res.json({ id: result.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/vorgaenge/:id', async (req, res) => {
  try {
    const { titel, typ, status, prioritaet, deadline, beschreibung } = req.body;
    const current = await queryOne('SELECT titel, imap_folder FROM vorgaenge WHERE id = ?', [req.params.id]);
    await query(
      'UPDATE vorgaenge SET titel=?, typ=?, status=?, prioritaet=?, deadline=?, beschreibung=? WHERE id=?',
      [titel, typ, status, prioritaet, deadline || null, beschreibung || null, req.params.id]
    );
    if (current?.imap_folder && titel && titel !== current.titel) {
      const newFolderPath = vorgangFolderPath(titel);
      await query('UPDATE vorgaenge SET imap_folder = ? WHERE id = ?', [newFolderPath, req.params.id]);
      renameVorgangFolderOnAllAccounts(current.imap_folder, newFolderPath)
        .catch(e => console.warn('[IMAP] Ordner-Umbenennung fehlgeschlagen:', e.message));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/vorgaenge/:id', async (req, res) => {
  try {
    const allowed = ['titel', 'typ', 'status', 'prioritaet', 'deadline', 'beschreibung', 'wiedervorlage_am'];
    const updates = [], params = [];

    // Für Titel-Änderung: IMAP-Ordner ggf. umbenennen
    let oldImapFolder = null;
    if ('titel' in req.body && req.body.titel) {
      const current = await queryOne('SELECT titel, imap_folder FROM vorgaenge WHERE id = ?', [req.params.id]);
      if (current?.imap_folder && req.body.titel !== current.titel) {
        oldImapFolder = current.imap_folder;
      }
    }

    for (const key of allowed) {
      if (key in req.body) { updates.push(`${key} = ?`); params.push(req.body[key] ?? null); }
    }
    if (!updates.length) return res.json({ ok: true });
    params.push(req.params.id);
    await query(`UPDATE vorgaenge SET ${updates.join(', ')} WHERE id = ?`, params);

    if (oldImapFolder) {
      const newFolderPath = vorgangFolderPath(req.body.titel);
      await query('UPDATE vorgaenge SET imap_folder = ? WHERE id = ?', [newFolderPath, req.params.id]);
      renameVorgangFolderOnAllAccounts(oldImapFolder, newFolderPath)
        .catch(e => console.warn('[IMAP] Ordner-Umbenennung fehlgeschlagen:', e.message));
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/vorgaenge/wiedervorlage', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, titel, typ, status, prioritaet, deadline, wiedervorlage_am
       FROM vorgaenge
       WHERE wiedervorlage_am IS NOT NULL AND wiedervorlage_am <= CURDATE() AND status != 'abgeschlossen'
       ORDER BY wiedervorlage_am ASC`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELEGATIONEN ──────────────────────────────────────────────────────────────
app.get('/delegationen', async (req, res) => {
  try {
    const rows = await query(`
      SELECT d.*, v.titel as vorgang_titel
      FROM delegationen d JOIN vorgaenge v ON v.id = d.vorgang_id
      WHERE d.status = 'offen'
      ORDER BY d.deadline ASC, d.created_at ASC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/delegationen/:id/erledigt', async (req, res) => {
  try {
    await query("UPDATE delegationen SET status = 'erledigt' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PERSONEN ──────────────────────────────────────────────────────────────────
app.get('/personen', async (req, res) => {
  try { res.json(await query('SELECT * FROM delegations_personen WHERE aktiv = 1 ORDER BY rolle, name')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/personen', async (req, res) => {
  try {
    const { name, rolle, email } = req.body;
    const [r] = await query('INSERT INTO delegations_personen (name, rolle, email) VALUES (?,?,?)', [name, rolle, email || null]);
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── E-MAILS ───────────────────────────────────────────────────────────────────
app.get('/emails', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const erledigt = req.query.erledigt === '1' ? 1 : 0;
    const params = [erledigt];
    let where = 'WHERE e.erledigt = ?';

    if (req.query.vorgang_id === '0') {
      where += ' AND e.vorgang_id IS NULL';
    } else if (req.query.vorgang_id) {
      where += ' AND e.vorgang_id = ?';
      params.push(parseInt(req.query.vorgang_id));
    }

    params.push(limit);
    const rows = await query(`
      SELECT e.*, a.label as account_label, a.color as account_color, v.titel as vorgang_titel
      FROM emails e
      JOIN email_accounts a ON a.id = e.account_id
      LEFT JOIN vorgaenge v ON v.id = e.vorgang_id
      ${where}
      ORDER BY e.date DESC LIMIT ?
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/emails/themen', async (req, res) => {
  try {
    const erledigt = req.query.erledigt === '1' ? 1 : 0;
    const [vorgaenge, unzugeordnet] = await Promise.all([
      query(
        `SELECT v.id, v.titel, COUNT(e.id) as count
         FROM vorgaenge v JOIN emails e ON e.vorgang_id = v.id
         WHERE e.erledigt = ?
         GROUP BY v.id ORDER BY count DESC LIMIT 20`,
        [erledigt]
      ),
      queryOne(
        'SELECT COUNT(*) as count FROM emails WHERE vorgang_id IS NULL AND erledigt = ?',
        [erledigt]
      ),
    ]);
    res.json({ vorgaenge, unzugeordnet: unzugeordnet.count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/emails/unzugeordnet', async (req, res) => {
  try {
    const rows = await query(`
      SELECT e.*, a.label as account_label, a.color as account_color
      FROM emails e JOIN email_accounts a ON a.id = e.account_id
      WHERE e.vorgang_id IS NULL AND e.unread = 1
      ORDER BY e.date DESC LIMIT 20
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/:id/zuordnen', async (req, res) => {
  try {
    const { vorgang_id } = req.body;
    await executeAction({ action: 'email_zuordnen', email_id: parseInt(req.params.id), vorgang_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/:id/einordnen', async (req, res) => {
  try {
    const email = await queryOne('SELECT * FROM emails WHERE id = ?', [req.params.id]);
    if (!email) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    const einordnung = await emailEinordnen(email);
    res.json(einordnung);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHAT ──────────────────────────────────────────────────────────────────────
app.post('/chat', upload.array('images', 5), async (req, res) => {
  try {
    const text    = req.body.text || '';
    const history = Array.isArray(req.body.history) ? req.body.history : JSON.parse(req.body.history || '[]');
    const smart   = req.body.smart === 'true' || req.body.smart === true;
    const images  = (req.files || []).map(f => ({
      base64: f.buffer.toString('base64'),
      mediaType: f.mimetype,
    }));
    const result = await chat({ history, text, images, smart: smart || images.length > 0 });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/chat/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const rows = await query('SELECT role, content, model, created_at FROM chat_messages ORDER BY created_at DESC LIMIT ?', [limit]);
    res.json(rows.reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── NOTIZ-ANALYSE ─────────────────────────────────────────────────────────────
app.post('/notiz/analysieren', upload.single('bild'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
    const result = await notizAnalysieren(req.file.buffer.toString('base64'), req.file.mimetype);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BRIEFING ──────────────────────────────────────────────────────────────────
app.post('/briefing', async (req, res) => {
  try {
    const text = await morgenbriefing();
    // Pushover wenn nicht manuell deaktiviert
    if (req.body?.push !== false) {
      const { pushBriefing } = await import('./pushover.js');
      pushBriefing(text).catch(() => {});
    }
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── E-MAIL-KONTEN ─────────────────────────────────────────────────────────────
app.get('/accounts/email', async (req, res) => {
  try { res.json(await query('SELECT id, label, email, host, port, tls, color, active FROM email_accounts')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/accounts/email', async (req, res) => {
  try {
    const { label, email, host, port, username, password, tls, color } = req.body;
    const [r] = await query(
      'INSERT INTO email_accounts (label, email, host, port, username, password, tls, color) VALUES (?,?,?,?,?,?,?,?)',
      [label, email, host, port || 993, username, password, tls !== false ? 1 : 0, color || '#d4a853']
    );
    res.json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SYNC ──────────────────────────────────────────────────────────────────────
app.post('/sync', async (req, res) => {
  try {
    const emailResults = await syncAllAccounts();

    // Neue E-Mails automatisch einordnen (parallel)
    const unzugeordnet = await query(
      'SELECT * FROM emails WHERE vorgang_id IS NULL AND ki_einordnung IS NULL ORDER BY date DESC LIMIT 10'
    );
    await Promise.all(unzugeordnet.map(async email => {
      const einordnung = await emailEinordnen(email);
      if (einordnung) {
        await query('UPDATE emails SET ki_einordnung = ? WHERE id = ?',
          [JSON.stringify(einordnung), email.id]);
      }
    }));

    res.json({ email: emailResults, eingeordnet: unzugeordnet.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const [emails, unread, vorgaenge, delegationen, tokens, lastSync] = await Promise.all([
      queryOne('SELECT COUNT(*) as n FROM emails'),
      queryOne('SELECT COUNT(*) as n FROM emails WHERE unread = 1'),
      queryOne("SELECT COUNT(*) as n FROM vorgaenge WHERE status != 'abgeschlossen'"),
      queryOne("SELECT COUNT(*) as n FROM delegationen WHERE status = 'offen'"),
      getTokenStats(),
      queryOne("SELECT MAX(created_at) as t FROM sync_log WHERE status = 'ok'"),
    ]);
    res.json({
      emails: emails.n, unread: unread.n,
      vorgaenge: vorgaenge.n, delegationen: delegationen.n,
      tokens, lastSync: lastSync?.t,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VOLLTEXT-SUCHE ────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ vorgaenge: [], emails: [], delegationen: [] });
    const ft = q + '*';
    const like = `%${q}%`;
    const [vorgaenge, emails, delegationen] = await Promise.all([
      query(
        `SELECT id, titel, status, prioritaet, deadline
         FROM vorgaenge WHERE MATCH(titel, beschreibung) AGAINST(? IN BOOLEAN MODE) LIMIT 10`,
        [ft]
      ),
      query(
        `SELECT e.id, e.subject, e.from_name, e.from_email, e.date, e.vorgang_id, v.titel as vorgang_titel
         FROM emails e LEFT JOIN vorgaenge v ON v.id = e.vorgang_id
         WHERE MATCH(e.subject, e.body_text) AGAINST(? IN BOOLEAN MODE)
         ORDER BY e.date DESC LIMIT 10`,
        [ft]
      ),
      query(
        `SELECT d.id, d.aufgabe, d.an_name, d.deadline, d.status, v.titel as vorgang_titel, v.id as vorgang_id
         FROM delegationen d JOIN vorgaenge v ON v.id = d.vorgang_id
         WHERE d.aufgabe LIKE ? OR d.an_name LIKE ? LIMIT 10`,
        [like, like]
      ),
    ]);
    res.json({ vorgaenge, emails, delegationen });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KI-SUCHE ──────────────────────────────────────────────────────────────────
app.get('/search/ai', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 3) return res.json({ vorgaenge: [], emails: [], delegationen: [], todos: [], erklaerung: '' });

    const filter = await naturalSearchQuery(q);
    if (!filter) return res.status(500).json({ error: 'KI-Filterung fehlgeschlagen' });

    const VALID_STATUS_V  = new Set(['offen','in_bearbeitung','wartet','abgeschlossen']);
    const VALID_PRIO      = new Set([1, 2, 3]);
    const VALID_KI_PRIO   = new Set(['hoch','mittel','niedrig']);
    const VALID_STATUS_D  = new Set(['offen','erledigt']);
    const dateRe          = /^\d{4}-\d{2}-\d{2}$/;
    const today           = new Date().toISOString().split('T')[0];

    const results = { vorgaenge: [], emails: [], delegationen: [], todos: [], erklaerung: filter.erklaerung || '' };
    const tabellen = Array.isArray(filter.tabellen) ? filter.tabellen : [];

    if (tabellen.includes('vorgaenge') && filter.vorgaenge) {
      const f = filter.vorgaenge;
      const where = [], params = [];

      if (Array.isArray(f.status) && f.status.length) {
        const valid = f.status.filter(s => VALID_STATUS_V.has(s));
        if (valid.length) { where.push(`v.status IN (${valid.map(() => '?').join(',')})`); params.push(...valid); }
      } else {
        where.push(`v.status != 'abgeschlossen'`);
      }
      if (Array.isArray(f.prioritaet) && f.prioritaet.length) {
        const valid = f.prioritaet.filter(p => VALID_PRIO.has(+p)).map(Number);
        if (valid.length) { where.push(`v.prioritaet IN (${valid.map(() => '?').join(',')})`); params.push(...valid); }
      }
      if (f.deadline_vor && dateRe.test(f.deadline_vor))  { where.push(`v.deadline <= ?`); params.push(f.deadline_vor); }
      if (f.deadline_nach && dateRe.test(f.deadline_nach)) { where.push(`v.deadline >= ?`); params.push(f.deadline_nach); }
      if (f.schlagwort && typeof f.schlagwort === 'string') {
        where.push(`(v.titel LIKE ? OR v.beschreibung LIKE ?)`);
        params.push(`%${f.schlagwort}%`, `%${f.schlagwort}%`);
      }
      if (f.wiedervorlage_faellig) {
        where.push(`v.wiedervorlage_am IS NOT NULL AND v.wiedervorlage_am <= ?`); params.push(today);
      }
      if (f.hat_offene_delegationen) {
        where.push(`(SELECT COUNT(*) FROM delegationen d WHERE d.vorgang_id = v.id AND d.status = 'offen') > 0`);
      }
      if (f.keine_aktivitaet_seit_tagen && Number.isFinite(+f.keine_aktivitaet_seit_tagen)) {
        where.push(`((SELECT MAX(e.created_at) FROM vorgang_eintraege e WHERE e.vorgang_id = v.id) < DATE_SUB(NOW(), INTERVAL ? DAY) OR NOT EXISTS (SELECT 1 FROM vorgang_eintraege e WHERE e.vorgang_id = v.id))`);
        params.push(+f.keine_aktivitaet_seit_tagen);
      }

      const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
      results.vorgaenge = await query(
        `SELECT v.id, v.titel, v.status, v.prioritaet, v.deadline FROM vorgaenge v ${whereStr} ORDER BY v.prioritaet ASC, v.deadline ASC LIMIT 15`,
        params
      );
    }

    if (tabellen.includes('emails') && filter.emails) {
      const f = filter.emails;
      const where = [], params = [];

      if (f.erledigt === 0 || f.erledigt === 1) { where.push(`e.erledigt = ?`); params.push(f.erledigt); }
      if (f.ki_prioritaet && VALID_KI_PRIO.has(f.ki_prioritaet)) {
        where.push(`e.ki_einordnung LIKE ?`); params.push(`%"ki_prioritaet":"${f.ki_prioritaet}"%`);
      }
      if (f.schlagwort && typeof f.schlagwort === 'string') {
        where.push(`(e.subject LIKE ? OR e.body_text LIKE ?)`);
        params.push(`%${f.schlagwort}%`, `%${f.schlagwort}%`);
      }
      if (f.von_name && typeof f.von_name === 'string') {
        where.push(`(e.from_name LIKE ? OR e.from_email LIKE ?)`);
        params.push(`%${f.von_name}%`, `%${f.von_name}%`);
      }
      if (f.datum_vor && dateRe.test(f.datum_vor))  { where.push(`e.date <= ?`); params.push(f.datum_vor); }
      if (f.datum_nach && dateRe.test(f.datum_nach)) { where.push(`e.date >= ?`); params.push(f.datum_nach); }

      const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
      results.emails = await query(
        `SELECT e.id, e.subject, e.from_name, e.from_email, e.date, e.vorgang_id, v.titel as vorgang_titel
         FROM emails e LEFT JOIN vorgaenge v ON v.id = e.vorgang_id
         ${whereStr} ORDER BY e.date DESC LIMIT 15`,
        params
      );
    }

    if (tabellen.includes('delegationen') && filter.delegationen) {
      const f = filter.delegationen;
      const where = [], params = [];

      if (f.status && VALID_STATUS_D.has(f.status)) { where.push(`d.status = ?`); params.push(f.status); }
      if (f.ueberfaellig) { where.push(`d.deadline < ?`); params.push(today); }
      if (f.an_name && typeof f.an_name === 'string') { where.push(`d.an_name LIKE ?`); params.push(`%${f.an_name}%`); }
      if (f.deadline_vor && dateRe.test(f.deadline_vor)) { where.push(`d.deadline <= ?`); params.push(f.deadline_vor); }

      const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
      results.delegationen = await query(
        `SELECT d.id, d.aufgabe, d.an_name, d.deadline, d.status, v.titel as vorgang_titel, v.id as vorgang_id
         FROM delegationen d JOIN vorgaenge v ON v.id = d.vorgang_id
         ${whereStr} ORDER BY d.deadline ASC LIMIT 15`,
        params
      );
    }

    if (tabellen.includes('todos') && filter.todos) {
      const f = filter.todos;
      const where = [], params = [];

      if (f.erledigt === 0 || f.erledigt === 1) { where.push(`t.erledigt = ?`); params.push(f.erledigt); }
      if (f.wichtig  === 0 || f.wichtig  === 1) { where.push(`t.wichtig = ?`);  params.push(f.wichtig); }
      if (f.dringend === 0 || f.dringend === 1) { where.push(`t.dringend = ?`); params.push(f.dringend); }
      if (f.faellig_vor  && dateRe.test(f.faellig_vor))  { where.push(`t.faellig_am <= ?`); params.push(f.faellig_vor); }
      if (f.faellig_nach && dateRe.test(f.faellig_nach)) { where.push(`t.faellig_am >= ?`); params.push(f.faellig_nach); }

      const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
      results.todos = await query(
        `SELECT t.id, t.titel, t.wichtig, t.dringend, t.faellig_am, v.titel as vorgang_titel, v.id as vorgang_id
         FROM todos t JOIN vorgaenge v ON v.id = t.vorgang_id
         ${whereStr} ORDER BY t.wichtig DESC, t.dringend DESC, t.faellig_am ASC LIMIT 15`,
        params
      );
    }

    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BOOX-SYNC ─────────────────────────────────────────────────────────────────
const normItem = (extra = {}) => ({ status: 'offen', ref_id: null, ...extra });
const normVorschlaege = (analyse) => ({
  ...analyse,
  aufgaben: (analyse.aufgaben || []).map(a => typeof a === 'string' ? normItem({ titel: a }) : normItem(a)),
  delegationen: (analyse.delegationen || []).map(d => normItem(d)),
  termine: (analyse.termine || []).map(t => normItem(t)),
});

async function booxNotizVerarbeiten(pfad, zielOrdner) {
  const buffer = await ncDownload(pfad);
  const dateiname = pfad.split('/').pop();

  // Bestehenden Eintrag mit gleichem Quelldateinamen suchen (Stammname inkl. .pdf,
  // weil der Versions-Suffix erst beim Verschieben in den Verarbeitet-Ordner
  // angehängt wird; im Quellordner bleibt der Name stabil).
  const existing = await queryOne(
    `SELECT id, vorgang_id, inhalt, datei_pfad FROM vorgang_eintraege
       WHERE titel = ? ORDER BY created_at DESC LIMIT 1`,
    [`Boox: ${dateiname}`]
  );

  let altAnalyse = null;
  let bekannteHashes = [];
  if (existing) {
    try {
      altAnalyse = JSON.parse(existing.inhalt);
      bekannteHashes = altAnalyse.seiten_hashes || [];
    } catch (e) {
      console.warn('[Boox] Vorhandener Eintrag hat kaputtes JSON, behandle als neu');
    }
  }

  const analyse = await notizAnalysieren(buffer.toString('base64'), 'application/pdf', bekannteHashes);

  // Re-Sync ohne neue Seiten → nur Datei verschieben, sonst nichts tun
  if (existing && altAnalyse && analyse.neue_seiten === 0) {
    // Aktuelle Hashes übernehmen (Reihenfolge könnte sich theoretisch geändert haben)
    altAnalyse.seiten_hashes = analyse.seiten_hashes;
    altAnalyse.seiten = analyse.seiten;
    await query('UPDATE vorgang_eintraege SET inhalt = ? WHERE id = ?', [JSON.stringify(altAnalyse), existing.id]);
    await booxVerarbeitet(pfad, zielOrdner);
    console.log(`[Boox] ${dateiname} → keine neuen Seiten, skip`);
    return { pfad, vorgangId: existing.vorgang_id, neue_seiten: 0, vorschlaege: 0 };
  }

  const neueVorschlaege = normVorschlaege(analyse);

  // Re-Sync mit neuen Seiten → an bestehenden Eintrag anhängen
  if (existing && altAnalyse) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    altAnalyse.seiten_hashes = analyse.seiten_hashes;
    altAnalyse.seiten = analyse.seiten;
    altAnalyse.transkription = (altAnalyse.transkription || '')
      + `\n\n--- Ergänzung ${stamp} ---\n`
      + (analyse.transkription || '');
    if (analyse.zusammenfassung) {
      // Zusammenfassung ergänzen statt überschreiben (alte könnte schon vom User
      // mental verarbeitet worden sein)
      altAnalyse.zusammenfassung = (altAnalyse.zusammenfassung || '')
        + `\n\n[${stamp}] ` + analyse.zusammenfassung;
    }
    altAnalyse.aufgaben = [...(altAnalyse.aufgaben || []), ...neueVorschlaege.aufgaben];
    altAnalyse.delegationen = [...(altAnalyse.delegationen || []), ...neueVorschlaege.delegationen];
    altAnalyse.termine = [...(altAnalyse.termine || []), ...neueVorschlaege.termine];

    await query(
      'UPDATE vorgang_eintraege SET inhalt = ?, datei_pfad = ? WHERE id = ?',
      [JSON.stringify(altAnalyse), pfad, existing.id]
    );
    await booxVerarbeitet(pfad, zielOrdner);
    const offen = neueVorschlaege.aufgaben.length + neueVorschlaege.delegationen.length + neueVorschlaege.termine.length;
    console.log(`[Boox] ${dateiname} → Vorgang #${existing.vorgang_id}, +${analyse.neue_seiten} Seiten, +${offen} Vorschläge`);
    return { pfad, vorgangId: existing.vorgang_id, neue_seiten: analyse.neue_seiten, vorschlaege: offen, analyse: altAnalyse };
  }

  // Erstverarbeitung: Vorgang-ID auflösen (direkt, per Titelsuche, oder neu anlegen)
  let vorgangId = analyse.vorgang_id ? parseInt(analyse.vorgang_id) : null;
  if (!vorgangId && analyse.vorgang_titel) {
    const vorhanden = await queryOne(
      'SELECT id FROM vorgaenge WHERE titel LIKE ? LIMIT 1',
      [`%${analyse.vorgang_titel}%`]
    );
    if (vorhanden) {
      vorgangId = vorhanden.id;
    } else {
      const ncPfad = await vorgangOrdner(analyse.vorgang_titel).catch(() => null);
      const result = await query(
        'INSERT INTO vorgaenge (titel, typ, beschreibung, nc_ordner) VALUES (?,?,?,?)',
        [analyse.vorgang_titel, 'sonstiges', `Aus Boox-Notiz: ${dateiname}`, ncPfad]
      );
      vorgangId = result.insertId;
    }
  }

  await query(
    'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, datei_pfad) VALUES (?,?,?,?,?)',
    [vorgangId, 'notiz', `Boox: ${dateiname}`, JSON.stringify(neueVorschlaege), pfad]
  );

  await booxVerarbeitet(pfad);
  const offen = neueVorschlaege.aufgaben.length + neueVorschlaege.delegationen.length + neueVorschlaege.termine.length;
  console.log(`[Boox] ${dateiname} → Vorgang #${vorgangId}, ${analyse.seiten} Seiten, ${offen} Vorschläge`);
  return { pfad, vorgangId, neue_seiten: analyse.seiten, vorschlaege: offen, analyse: neueVorschlaege };
}

// Liest die konfigurierten PDF-Notiz-Ordner aus settings; fällt auf den
// historischen Boox-Default zurück, falls noch keine Konfiguration existiert.
async function getPdfNotizOrdner() {
  try {
    const row = await queryOne("SELECT value FROM settings WHERE `key` = 'pdf_notiz_ordner'");
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .filter(o => o && typeof o.quelle === 'string' && o.quelle.trim())
          .map(o => ({
            quelle: o.quelle.trim(),
            ziel: (o.ziel || '').trim() || defaultZielOrdner(o.quelle.trim()),
            label: (o.label || '').trim() || o.quelle.trim().split('/').filter(Boolean).pop(),
          }));
      }
    }
  } catch (e) {
    console.warn('[PDF-Notizen] Settings parse-Fehler:', e.message);
  }
  return [{ quelle: BOOX_PFAD, ziel: BOOX_VERARBEITET, label: 'Boox' }];
}

app.post('/boox/sync', async (req, res) => {
  try {
    const ordner = await getPdfNotizOrdner();
    const ergebnisse = [];
    for (const o of ordner) {
      const notizen = await neueBooxNotizen(o.quelle);
      for (const pfad of notizen) {
        ergebnisse.push(await booxNotizVerarbeiten(pfad, o.ziel));
      }
    }
    res.json({ verarbeitet: ergebnisse.length, ergebnisse });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CRUD für PDF-Notiz-Ordner: Liste lesen, ergänzen, entfernen.
app.get('/pdf-notiz-ordner', async (req, res) => {
  try {
    const ordner = await getPdfNotizOrdner();
    res.json(ordner);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/pdf-notiz-ordner', async (req, res) => {
  try {
    const list = Array.isArray(req.body?.ordner) ? req.body.ordner : null;
    if (!list) return res.status(400).json({ error: 'Erwarte { ordner: [...] }' });
    const sauber = [];
    for (const o of list) {
      const quelle = (o?.quelle || '').trim();
      if (!quelle.startsWith('/')) {
        return res.status(400).json({ error: `Pfad muss mit / beginnen: "${quelle}"` });
      }
      const ziel = (o?.ziel || '').trim() || defaultZielOrdner(quelle);
      if (!ziel.startsWith('/')) {
        return res.status(400).json({ error: `Zielpfad muss mit / beginnen: "${ziel}"` });
      }
      if (ziel === quelle) {
        return res.status(400).json({ error: `Quell- und Zielordner müssen sich unterscheiden: "${quelle}"` });
      }
      const label = (o?.label || '').trim() || quelle.split('/').filter(Boolean).pop();
      sauber.push({ quelle, ziel, label });
    }
    await query(
      'INSERT INTO settings (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      ['pdf_notiz_ordner', JSON.stringify(sauber)]
    );
    res.json({ ok: true, ordner: sauber });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Prüft, ob ein Quellordner auf Nextcloud existiert (für UI-Validierung).
app.post('/pdf-notiz-ordner/pruefen', async (req, res) => {
  try {
    const pfad = (req.body?.pfad || '').trim();
    if (!pfad.startsWith('/')) return res.status(400).json({ ok: false, error: 'Pfad muss mit / beginnen' });
    const exists = await ncOrdnerExistiert(pfad);
    res.json({ ok: true, exists });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/boox/status', async (req, res) => {
  try {
    const eintraege = await query(
      `SELECT id, vorgang_id, titel, inhalt, datei_pfad, created_at
       FROM vorgang_eintraege
       WHERE titel LIKE 'Boox:%' OR titel LIKE 'Diktat:%'
       ORDER BY created_at DESC LIMIT 5`
    );
    res.json(eintraege);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Übersicht: alle verarbeiteten Notizen (Boox-PDFs und Plaud-Diktate) + verlinkter Vorgang
app.get('/boox/notizen', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const eintraege = await query(
      `SELECT e.id, e.vorgang_id, e.titel, e.inhalt, e.datei_pfad, e.created_at,
              v.titel AS vorgang_titel, v.status AS vorgang_status
         FROM vorgang_eintraege e
         LEFT JOIN vorgaenge v ON v.id = e.vorgang_id
        WHERE e.titel LIKE 'Boox:%' OR e.titel LIKE 'Diktat:%'
        ORDER BY e.created_at DESC
        LIMIT ?`,
      [limit]
    );
    res.json(eintraege);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vorschlag aus Notiz (Boox-PDF oder Diktat) übernehmen oder verwerfen.
// Body: { typ: 'aufgabe'|'delegation'|'termin', index: N, daten?: {...} }
async function loadBooxEintrag(eintragId) {
  const row = await queryOne(
    `SELECT id, vorgang_id, inhalt FROM vorgang_eintraege
     WHERE id = ? AND (titel LIKE 'Boox:%' OR titel LIKE 'Diktat:%')`,
    [eintragId]
  );
  if (!row) throw new Error('Notiz-Eintrag nicht gefunden');
  let analyse;
  try { analyse = JSON.parse(row.inhalt); } catch { throw new Error('Notiz-Eintrag: JSON kaputt'); }
  return { row, analyse };
}

function listFor(analyse, typ) {
  if (typ === 'aufgabe') return analyse.aufgaben || (analyse.aufgaben = []);
  if (typ === 'delegation') return analyse.delegationen || (analyse.delegationen = []);
  if (typ === 'termin') return analyse.termine || (analyse.termine = []);
  throw new Error('Unbekannter typ: ' + typ);
}

app.post('/boox/:eintragId/uebernehmen', async (req, res) => {
  try {
    const eintragId = parseInt(req.params.eintragId);
    const { typ, index, daten = {} } = req.body || {};
    const { row, analyse } = await loadBooxEintrag(eintragId);
    const items = listFor(analyse, typ);
    const item = items[index];
    if (!item) return res.status(404).json({ error: 'Vorschlag-Index ungültig' });
    if (item.status === 'uebernommen') return res.status(409).json({ error: 'Bereits übernommen', ref_id: item.ref_id });

    const merged = { ...item, ...daten };
    let refId = null;

    if (typ === 'aufgabe') {
      const titel = (merged.titel || '').trim();
      if (!titel) return res.status(400).json({ error: 'Titel fehlt' });
      const r = await query(
        'INSERT INTO todos (vorgang_id, titel, beschreibung, faellig_am, wichtig, dringend) VALUES (?,?,?,?,?,?)',
        [row.vorgang_id, titel, merged.beschreibung || null, merged.faellig_am || null,
         merged.wichtig ? 1 : 0, merged.dringend ? 1 : 0]
      );
      refId = r.insertId;
    } else if (typ === 'delegation') {
      const an = (merged.an || '').trim();
      const aufg = (merged.aufgabe || '').trim();
      if (!an || !aufg) return res.status(400).json({ error: 'an und aufgabe erforderlich' });
      const person = await queryOne(
        'SELECT id, rolle FROM delegations_personen WHERE name = ? AND aktiv = 1',
        [an]
      );
      const r = await query(
        'INSERT INTO delegationen (vorgang_id, person_id, an_name, an_rolle, aufgabe, deadline) VALUES (?,?,?,?,?,?)',
        [row.vorgang_id, person?.id || null, an, person?.rolle || 'sonstiges', aufg, merged.deadline || null]
      );
      refId = r.insertId;
      await query(
        'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, ref_id) VALUES (?,?,?,?,?)',
        [row.vorgang_id, 'delegation', `Delegation an ${an}`, aufg, refId]
      );
    } else if (typ === 'termin') {
      const titel = (merged.titel || '').trim();
      if (!titel) return res.status(400).json({ error: 'Titel fehlt' });
      const datum = merged.datum;
      if (!datum) return res.status(400).json({ error: 'Datum fehlt' });
      const startDt = merged.uhrzeit
        ? new Date(`${datum}T${merged.uhrzeit}:00`)
        : new Date(datum);
      if (isNaN(startDt.getTime())) return res.status(400).json({ error: 'Datum/Uhrzeit ungültig' });
      const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
      const uid = `boox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const r = await query(
        'INSERT INTO events (vorgang_id, uid, title, start_time, end_time, all_day) VALUES (?,?,?,?,?,?)',
        [row.vorgang_id, uid, titel, startDt.toISOString(), endDt.toISOString(), merged.uhrzeit ? 0 : 1]
      );
      refId = r.insertId;
    }

    items[index] = { ...merged, status: 'uebernommen', ref_id: refId };
    await query('UPDATE vorgang_eintraege SET inhalt = ? WHERE id = ?', [JSON.stringify(analyse), eintragId]);
    res.json({ ok: true, ref_id: refId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/boox/:eintragId/verwerfen', async (req, res) => {
  try {
    const eintragId = parseInt(req.params.eintragId);
    const { typ, index } = req.body || {};
    const { analyse } = await loadBooxEintrag(eintragId);
    const items = listFor(analyse, typ);
    if (!items[index]) return res.status(404).json({ error: 'Vorschlag-Index ungültig' });
    items[index] = { ...items[index], status: 'verworfen' };
    await query('UPDATE vorgang_eintraege SET inhalt = ? WHERE id = ?', [JSON.stringify(analyse), eintragId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Status zurücksetzen (z.B. bei Fehlbedienung)
app.post('/boox/:eintragId/reset', async (req, res) => {
  try {
    const eintragId = parseInt(req.params.eintragId);
    const { typ, index } = req.body || {};
    const { analyse } = await loadBooxEintrag(eintragId);
    const items = listFor(analyse, typ);
    if (!items[index]) return res.status(404).json({ error: 'Vorschlag-Index ungültig' });
    items[index] = { ...items[index], status: 'offen', ref_id: null };
    await query('UPDATE vorgang_eintraege SET inhalt = ? WHERE id = ?', [JSON.stringify(analyse), eintragId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DIKTATE (Plaud / Webhook) ─────────────────────────────────────────────────
const DIKTAT_SECRET_KEY = 'diktat_webhook_secret';

async function getDiktatSecret() {
  const row = await queryOne('SELECT value FROM settings WHERE `key` = ?', [DIKTAT_SECRET_KEY]);
  return row?.value || null;
}

app.get('/diktat-webhook-secret', async (req, res) => {
  try {
    const value = await getDiktatSecret();
    res.json({ value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/diktat-webhook-secret/generieren', async (req, res) => {
  try {
    const secret = randomBytes(32).toString('base64url');
    await query(
      'INSERT INTO settings (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [DIKTAT_SECRET_KEY, secret]
    );
    res.json({ value: secret });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/diktat-webhook-secret', async (req, res) => {
  try {
    await query('DELETE FROM settings WHERE `key` = ?', [DIKTAT_SECRET_KEY]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook für Plaud (über Zapier o.ä.). Eigene Authentifizierung via X-Webhook-Secret.
app.post('/diktate', async (req, res) => {
  try {
    const expected = await getDiktatSecret();
    if (!expected) {
      return res.status(503).json({ error: 'Webhook-Secret nicht eingerichtet' });
    }
    const provided = req.headers['x-webhook-secret'] || '';
    const a = Buffer.from(String(provided));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { titel, transkript, aufgenommen_am, audio_url, dauer_sekunden, summary } = req.body || {};
    if (!titel || typeof titel !== 'string') return res.status(400).json({ error: 'Pflichtfeld titel fehlt' });
    if (!transkript || typeof transkript !== 'string') return res.status(400).json({ error: 'Pflichtfeld transkript fehlt' });
    if (!aufgenommen_am) return res.status(400).json({ error: 'Pflichtfeld aufgenommen_am fehlt' });

    const result = await diktatVerarbeiten({
      titel: titel.trim(),
      transkript,
      aufgenommenAm: aufgenommen_am,
      audioUrl: audio_url || null,
      dauerSekunden: dauer_sekunden || null,
      zusammenfassungPlaud: summary || null,
    });
    res.json({
      ok: true,
      eintrag_id: result.eintragId,
      vorgang_id: result.vorgangId,
      vorschlaege: result.vorschlaege,
    });
  } catch (e) {
    console.error('[Diktat] Webhook-Fehler:', e);
    res.status(500).json({ error: e.message });
  }
});

// Audio einer Diktat-Notiz streamen (durchgereicht von Nextcloud, mit App-Auth).
app.get('/diktate/:eintragId/audio', async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT datei_pfad FROM vorgang_eintraege
       WHERE id = ? AND titel LIKE 'Diktat:%'`,
      [req.params.eintragId]
    );
    if (!row?.datei_pfad) return res.status(404).json({ error: 'Audio nicht gefunden' });
    const buf = await ncDownload(row.datei_pfad);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CRON ──────────────────────────────────────────────────────────────────────
const interval = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 5;

// Briefing-Zeit zur Laufzeit umplanbar
let briefingTask = null;
async function getBriefingTime() {
  const row = await queryOne("SELECT value FROM settings WHERE `key` = 'briefing_time'");
  if (row && /^\d{1,2}:\d{2}$/.test(row.value)) {
    const [h, m] = row.value.split(':').map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return { h, m };
  }
  return {
    h: parseInt(process.env.BRIEFING_HOUR) || 6,
    m: parseInt(process.env.BRIEFING_MINUTE) || 30,
  };
}
async function planBriefing() {
  if (briefingTask) { try { briefingTask.stop(); } catch (e) {} briefingTask = null; }
  const { h, m } = await getBriefingTime();
  briefingTask = cron.schedule(`${m} ${h} * * *`, async () => {
    console.log('[Briefing] Erstelle Morgen-Briefing...');
    try { await morgenbriefing(); console.log('[Briefing] OK'); }
    catch (e) { console.error('[Briefing] Fehler:', e.message); }
  });
  console.log(`[Briefing] Geplant für ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} Uhr`);
}

if (!global._cronStarted) {
  global._cronStarted = true;

  // E-Mail-Sync
  cron.schedule(`*/${interval} * * * *`, async () => {
    console.log(`[${new Date().toISOString()}] Auto-Sync...`);
    try { await syncAllAccounts(); console.log('Sync OK'); }
    catch (e) { console.error('Sync Fehler:', e.message); }
  });

  // Morgen-Briefing (Zeit aus settings, asynchron beim Boot)
  planBriefing().catch(e => console.error('[Briefing] Plan-Fehler:', e.message));

  // INBOX-UID-Abgleich: außerhalb INBOX = erledigt (stündlich, Minute 45)
  cron.schedule('45 * * * *', async () => {
    try { await syncErledigtStatus(); }
    catch (e) { console.error('[IMAP] syncErledigtStatus Fehler:', e.message); }
  });

  // Boox-Notizen (stündlich zur vollen Stunde)
  cron.schedule('0 * * * *', async () => {
    try {
      const ordner = await getPdfNotizOrdner();
      for (const o of ordner) {
        const notizen = await neueBooxNotizen(o.quelle);
        for (const pfad of notizen) await booxNotizVerarbeiten(pfad, o.ziel);
      }
    } catch (e) { console.error('[Boox] Cron-Fehler:', e.message); }
  });

  // Kalender-Sync (stündlich, versetzt zu Boox)
  cron.schedule('15 * * * *', async () => {
    try {
      const { syncAllCalendars } = await import('./caldav.js');
      await syncAllCalendars();
      console.log('[Kalender] Auto-Sync OK');
    } catch (e) { console.error('[Kalender] Sync Fehler:', e.message); }
  });
}

// ── Error Handler ─────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await initSchema();
  try {
    const row = await queryOne("SELECT value FROM settings WHERE `key` = 'api_secret'");
    if (row && row.value) {
      CURRENT_SECRET = row.value;
      console.log('[Auth] App-Passwort aus settings-Tabelle geladen');
    }
  } catch(e) { console.error('[Auth] Konnte api_secret nicht laden:', e.message); }
  await ncMkdir('/Vorgaenge').catch(() => {});
  await ncMkdir('/E-Mail-Anhänge').catch(() => {});
  await ncMkdir('/reMarkable').catch(() => {});
  await ncMkdir('/reMarkable/neu').catch(() => {});
  await ncMkdir('/reMarkable/verarbeitet').catch(() => {});

  app.listen(PORT, '127.0.0.1', async () => {
    console.log(`KI-Assistent v2 läuft auf http://127.0.0.1:${PORT}`);
    const bt = await getBriefingTime();
    console.log(`Sync alle ${interval} Min. | Briefing ${String(bt.h).padStart(2,'0')}:${String(bt.m).padStart(2,'0')} Uhr`);
  });
}

start().catch(err => { console.error('Startfehler:', err); process.exit(1); });

// ── E-MAIL DETAIL + ANTWORTEN ─────────────────────────────────────────────────
app.get('/emails/:id', async (req, res) => {
  try {
    const email = await queryOne(`
      SELECT e.*, a.label as account_label, a.color as account_color,
             a.email as account_email, a.id as aid,
             v.titel as vorgang_titel
      FROM emails e
      JOIN email_accounts a ON a.id = e.account_id
      LEFT JOIN vorgaenge v ON v.id = e.vorgang_id
      WHERE e.id = ?
    `, [req.params.id]);
    if (!email) return res.status(404).json({ error: 'Nicht gefunden' });
    await query('UPDATE emails SET unread = 0 WHERE id = ?', [req.params.id]);
    res.json(email);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/:id/archivieren', async (req, res) => {
  try {
    await query('UPDATE emails SET unread = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/:id/erledigt', async (req, res) => {
  try {
    const email = await queryOne(`
      SELECT e.*, a.host, a.port, a.username, a.password, a.tls
      FROM emails e JOIN email_accounts a ON a.id = e.account_id
      WHERE e.id = ?
    `, [req.params.id]);
    if (!email) return res.status(404).json({ error: 'Nicht gefunden' });

    if (email.vorgang_id) {
      // E-Mail gehört zu einem Vorgang → im Vorgang-Ordner belassen, nur als erledigt markieren
      await query('UPDATE emails SET erledigt = 1, unread = 0 WHERE id = ?', [req.params.id]);
    } else {
      // Keine Vorgang-Zuordnung → in IMAP-Ordner "Erledigt" verschieben
      await query('UPDATE emails SET erledigt = 1, unread = 0, imap_mailbox = ? WHERE id = ?', ['Erledigt', req.params.id]);
      try {
        await moveToErledigt(email, email.uid, email.imap_mailbox || 'INBOX');
      } catch (imapErr) {
        console.warn('[Erledigt] IMAP-Verschiebung fehlgeschlagen:', imapErr.message);
      }
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/:id/antworten', async (req, res) => {
  try {
    const { body, vorgang_id } = req.body;
    const email = await queryOne('SELECT * FROM emails WHERE id = ?', [req.params.id]);
    if (!email) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    const { sendReply } = await import('./smtp.js');
    const result = await sendReply({
      accountId: email.account_id,
      toEmail: email.from_email,
      toName: email.from_name,
      subject: email.subject,
      body,
      inReplyTo: email.message_id,
      references: email.message_id,
    });
    if (vorgang_id) {
      await query(
        'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt) VALUES (?,?,?,?)',
        [vorgang_id, 'email', `Antwort: ${email.subject}`, body]
      );
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/:id/ki-entwurf', async (req, res) => {
  try {
    const email = await queryOne('SELECT * FROM emails WHERE id = ?', [req.params.id]);
    if (!email) return res.status(404).json({ error: 'Nicht gefunden' });
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: process.env.MODEL_FAST || 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Schreibe eine kurze, professionelle Antwort auf diese E-Mail im Namen von ${process.env.OWNER_NAME || "der Schulleitung"}.
Ton: höflich, direkt, schulisch-professionell. Nur den Antworttext, keine Grußformel und keine Erklärungen.

Von: ${email.from_name || email.from_email}
Betreff: ${email.subject}
Inhalt: ${(email.body_text || '').slice(0, 800) || '(kein Inhalt verfügbar – nur Metadaten)'}`,
      }],
    });
    res.json({ entwurf: response.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KALENDER ──────────────────────────────────────────────────────────────────
app.get('/accounts/calendar', async (req, res) => {
  try { res.json(await query('SELECT id, label, url, color, active FROM calendars ORDER BY label')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/accounts/calendar', async (req, res) => {
  try {
    const { label, url, username, password, color } = req.body;
    const { testCalDav } = await import('./caldav.js');
    await testCalDav(url, username, password); // Verbindung testen
    const result = await query(
      'INSERT INTO calendars (label, url, username, password, color) VALUES (?,?,?,?,?)',
      [label, url, username, password, color || '#8fb87a']
    );
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/accounts/calendar/:id', async (req, res) => {
  try {
    await query('DELETE FROM calendars WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/accounts/calendar/test', async (req, res) => {
  try {
    const { url, username, password } = req.body;
    const { testCalDav } = await import('./caldav.js');
    const result = await testCalDav(url, username, password);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── E-MAIL-KONTEN LÖSCHEN ─────────────────────────────────────────────────────
app.delete('/accounts/email/:id', async (req, res) => {
  try {
    await query('DELETE FROM email_accounts WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/accounts/email/test', async (req, res) => {
  try {
    const { host, port, username, password, tls } = req.body;
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host, port: parseInt(port) || 993, secure: tls !== false,
      auth: { user: username, pass: password },
      logger: false, connectionTimeout: 10000,
    });
    client.on('error', () => {});
    await client.connect();
    await client.logout();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PERSONEN ──────────────────────────────────────────────────────────────────
app.put('/personen/:id', async (req, res) => {
  try {
    const { name, rolle, email } = req.body;
    await query('UPDATE delegations_personen SET name=?, rolle=?, email=? WHERE id=?',
      [name, rolle, email || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/personen/:id', async (req, res) => {
  try {
    await query('UPDATE delegations_personen SET aktiv=0 WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KALENDER-SYNC ─────────────────────────────────────────────────────────────
app.post('/sync/calendar', async (req, res) => {
  try {
    const { syncAllCalendars } = await import('./caldav.js');
    const result = await syncAllCalendars();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TERMINE ───────────────────────────────────────────────────────────────────
app.get('/events', async (req, res) => {
  try {
    let from, until, limit;
    if (req.query.from && req.query.to) {
      from = new Date(req.query.from);
      until = new Date(req.query.to);
      if (isNaN(from) || isNaN(until)) return res.status(400).json({ error: 'Ungültige from/to-Werte' });
      limit = parseInt(req.query.limit) || 2000;
    } else {
      const days = parseInt(req.query.days) || 14;
      from = new Date();
      until = new Date();
      until.setDate(until.getDate() + days);
      limit = parseInt(req.query.limit) || 100;
    }
    const rows = await query(`
      SELECT e.*, c.label as cal_label, c.color as cal_color
      FROM events e JOIN calendars c ON c.id = e.calendar_id
      WHERE e.end_time >= ? AND e.start_time <= ?
      ORDER BY e.start_time ASC LIMIT ?
    `, [from.toISOString(), until.toISOString(), limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
const SENSITIVE_SETTINGS = new Set(['api_secret']);

app.get('/settings', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM settings');
    const s = {};
    for (const r of rows) {
      if (SENSITIVE_SETTINGS.has(r.key)) continue;
      s[r.key] = r.value;
    }
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/settings/:key', async (req, res) => {
  try {
    const key = req.params.key;
    if (SENSITIVE_SETTINGS.has(key)) {
      return res.status(403).json({ error: 'Dieser Schlüssel kann nicht direkt gesetzt werden.' });
    }
    const value = req.body.value ?? null;
    if (key === 'briefing_time' && value && !/^\d{1,2}:\d{2}$/.test(value)) {
      return res.status(400).json({ error: 'Ungültiges Zeitformat (HH:MM erwartet)' });
    }
    await query(
      'INSERT INTO settings (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [key, value]
    );
    if (key === 'briefing_time') {
      await planBriefing().catch(e => console.error('[Briefing] Reschedule:', e.message));
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── APP-PASSWORT ÄNDERN ───────────────────────────────────────────────────────
app.post('/system/change-password', async (req, res) => {
  try {
    const { altes_passwort, neues_passwort } = req.body || {};
    if (!altes_passwort || !neues_passwort) {
      return res.status(400).json({ error: 'Altes und neues Passwort erforderlich.' });
    }
    if (altes_passwort !== CURRENT_SECRET) {
      return res.status(401).json({ error: 'Altes Passwort stimmt nicht.' });
    }
    if (neues_passwort.length < 8) {
      return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
    }
    if (neues_passwort === altes_passwort) {
      return res.status(400).json({ error: 'Neues Passwort muss sich vom alten unterscheiden.' });
    }
    await query(
      'INSERT INTO settings (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      ['api_secret', neues_passwort]
    );
    CURRENT_SECRET = neues_passwort;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TODOS ─────────────────────────────────────────────────────────────────────
app.get('/todos', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.vorgang_id) { where.push('t.vorgang_id = ?'); params.push(req.query.vorgang_id); }
    if (req.query.erledigt !== undefined) { where.push('t.erledigt = ?'); params.push(parseInt(req.query.erledigt)); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await query(
      `SELECT t.*, v.titel as vorgang_titel FROM todos t
       JOIN vorgaenge v ON v.id = t.vorgang_id
       ${clause}
       ORDER BY t.erledigt ASC, t.faellig_am ASC, t.created_at ASC`,
      params
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/todos', async (req, res) => {
  try {
    const { vorgang_id, titel, beschreibung, faellig_am, wichtig, dringend } = req.body;
    const setting = await queryOne("SELECT value FROM settings WHERE `key` = 'todo_calendar_id'");
    const calId = setting?.value ? parseInt(setting.value) : null;

    let eventUid = null;
    let eventCalId = null;
    if (calId && faellig_am) {
      const quadrant = wichtig && dringend ? 'Sofort erledigen'
        : wichtig ? 'Terminieren'
        : dringend ? 'Delegieren' : 'Eliminieren';
      eventUid = randomUUID();
      await createCalDavEvent(calId, {
        uid: eventUid,
        title: `☑ ${titel}`,
        start: faellig_am,
        description: beschreibung ? `${beschreibung}\n[${quadrant}]` : `[${quadrant}]`,
      });
      eventCalId = calId;
    }

    const result = await query(
      'INSERT INTO todos (vorgang_id, titel, beschreibung, faellig_am, wichtig, dringend, event_uid, calendar_id) VALUES (?,?,?,?,?,?,?,?)',
      [vorgang_id, titel, beschreibung || null, faellig_am || null, wichtig ? 1 : 0, dringend ? 1 : 0, eventUid, eventCalId]
    );
    res.json({ id: result.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/todos/:id/erledigt', async (req, res) => {
  try {
    await query('UPDATE todos SET erledigt = 1, erledigt_am = NOW() WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/todos/:id', async (req, res) => {
  try {
    const todo = await queryOne('SELECT * FROM todos WHERE id = ?', [req.params.id]);
    if (!todo) return res.status(404).json({ error: 'Nicht gefunden' });

    const allowed = ['titel', 'beschreibung', 'faellig_am', 'wichtig', 'dringend'];
    const updates = [], params = [];
    for (const key of allowed) {
      if (key in req.body) {
        updates.push(`${key} = ?`);
        if (key === 'wichtig' || key === 'dringend') params.push(req.body[key] ? 1 : 0);
        else params.push(req.body[key] ?? null);
      }
    }
    if (!updates.length) return res.json({ ok: true });
    params.push(req.params.id);
    await query(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`, params);

    const newFaellig = 'faellig_am' in req.body ? req.body.faellig_am : todo.faellig_am;
    const newTitel = 'titel' in req.body ? req.body.titel : todo.titel;
    const newWichtig = 'wichtig' in req.body ? !!req.body.wichtig : !!todo.wichtig;
    const newDringend = 'dringend' in req.body ? !!req.body.dringend : !!todo.dringend;

    if (todo.event_uid && todo.calendar_id) {
      await deleteCalDavEvent(todo.calendar_id, todo.event_uid).catch(() => {});
      if (newFaellig) {
        const quadrant = newWichtig && newDringend ? 'Sofort erledigen'
          : newWichtig ? 'Terminieren'
          : newDringend ? 'Delegieren' : 'Eliminieren';
        const newUid = randomUUID();
        await createCalDavEvent(todo.calendar_id, {
          uid: newUid,
          title: `☑ ${newTitel}`,
          start: newFaellig,
          description: `[${quadrant}]`,
        });
        await query('UPDATE todos SET event_uid = ? WHERE id = ?', [newUid, req.params.id]);
      } else {
        await query('UPDATE todos SET event_uid = NULL, calendar_id = NULL WHERE id = ?', [req.params.id]);
      }
    } else if (!todo.event_uid && newFaellig) {
      const setting = await queryOne("SELECT value FROM settings WHERE `key` = 'todo_calendar_id'");
      const calId = setting?.value ? parseInt(setting.value) : null;
      if (calId) {
        const quadrant = newWichtig && newDringend ? 'Sofort erledigen'
          : newWichtig ? 'Terminieren'
          : newDringend ? 'Delegieren' : 'Eliminieren';
        const uid = randomUUID();
        await createCalDavEvent(calId, {
          uid,
          title: `☑ ${newTitel}`,
          start: newFaellig,
          description: `[${quadrant}]`,
        });
        await query('UPDATE todos SET event_uid = ?, calendar_id = ? WHERE id = ?', [uid, calId, req.params.id]);
      }
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/todos/:id', async (req, res) => {
  try {
    const todo = await queryOne('SELECT * FROM todos WHERE id = ?', [req.params.id]);
    if (!todo) return res.status(404).json({ error: 'Nicht gefunden' });
    if (todo.event_uid && todo.calendar_id) {
      await deleteCalDavEvent(todo.calendar_id, todo.event_uid).catch(() => {});
    }
    await query('DELETE FROM todos WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SYSTEM-CONFIG ─────────────────────────────────────────────────────────────
app.get('/system/config', async (req, res) => {
  try {
    const [emailCount, calCount, personCount, tokenStats] = await Promise.all([
      queryOne('SELECT COUNT(*) as n FROM email_accounts WHERE active=1'),
      queryOne('SELECT COUNT(*) as n FROM calendars WHERE active=1'),
      queryOne('SELECT COUNT(*) as n FROM delegations_personen WHERE aktiv=1'),
      getTokenStats(),
    ]);
    const bt = await getBriefingTime();
    res.json({
      email_accounts: emailCount.n,
      calendars: calCount.n,
      personen: personCount.n,
      sync_interval: process.env.SYNC_INTERVAL_MINUTES || 5,
      briefing_time: `${String(bt.h).padStart(2,'0')}:${String(bt.m).padStart(2,'0')}`,
      token_stats: tokenStats,
      nc_url: process.env.NC_URL,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUSHOVER ──────────────────────────────────────────────────────────────────
app.post('/push/test', async (req, res) => {
  try {
    const { pushTest } = await import('./pushover.js');
    const r = await pushTest();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/push/send', async (req, res) => {
  try {
    const { title, message, priority } = req.body;
    const { push } = await import('./pushover.js');
    const r = await push(title || 'KI-Assistent', message, { priority: priority || 0 });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Überfällige Delegationen täglich um 8:00 pushen
if (!global._pushCronStarted) {
  global._pushCronStarted = true;
  cron.schedule('0 8 * * *', async () => {
    try {
      const { pushDelegationFaellig } = await import('./pushover.js');
      const ueberfaellig = await query(`
        SELECT d.aufgabe, d.an_name, v.titel as vorgang_titel
        FROM delegationen d JOIN vorgaenge v ON v.id = d.vorgang_id
        WHERE d.status = 'offen' AND d.deadline < CURDATE()
        LIMIT 5
      `);
      for (const d of ueberfaellig) {
        await pushDelegationFaellig(d.aufgabe, d.an_name, d.vorgang_titel);
      }
    } catch(e) { console.error('[Push] Delegation-Cron:', e.message); }
  });

  // Todo-Erinnerungen täglich um 8:05
  cron.schedule('5 8 * * *', async () => {
    try {
      const { pushTodosFaellig } = await import('./pushover.js');
      const todos = await query(`
        SELECT t.titel, t.faellig_am, v.titel as vorgang_titel
        FROM todos t JOIN vorgaenge v ON v.id = t.vorgang_id
        WHERE t.erledigt = 0 AND t.faellig_am IS NOT NULL AND DATE(t.faellig_am) <= CURDATE()
        ORDER BY t.faellig_am ASC
        LIMIT 20
      `);
      if (todos.length) await pushTodosFaellig(todos);
    } catch(e) { console.error('[Push] Todo-Cron:', e.message); }
  });

  // Termin-Erinnerungen alle 15 Min. prüfen
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { pushTerminErinnerung } = await import('./pushover.js');
      const in30 = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const in45 = new Date(Date.now() + 45 * 60 * 1000).toISOString();
      const termine = await query(
        `SELECT * FROM events WHERE start_time >= ? AND start_time <= ? AND all_day = 0`,
        [in30, in45]
      );
      for (const t of termine) {
        await pushTerminErinnerung(t.title, t.start_time, t.location);
      }
    } catch(e) { /* Kalender optional */ }
  });
}

// ── KALENDER DISCOVERY ────────────────────────────────────────────────────────
async function discoverCalendarsAt(rootUrl, username, password) {
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const { default: fetch } = await import('node-fetch');

  const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
    <d:prop>
      <d:displayname/>
      <d:resourcetype/>
      <cs:getctag/>
      <c:supported-calendar-component-set/>
    </d:prop>
  </d:propfind>`;

  const r = await fetch(rootUrl, {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: '1', 'Content-Type': 'application/xml' },
    body,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();

  const responses = [...xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)];
  const calendars = [];
  const rootPath = new URL(rootUrl).pathname.replace(/\/$/, '');
  const techFolders = ['inbox', 'outbox', 'trashbin'];

  for (const [, block] of responses) {
    const href = block.match(/<d:href>([^<]+)<\/d:href>/)?.[1];
    const name = block.match(/<d:displayname>([^<]*)<\/d:displayname>/)?.[1] || '';
    const isVEvent = block.includes('VEVENT') || !block.includes('VTODO');
    if (!href || !name) continue;

    const hrefClean = href.replace(/\/$/, '');
    if (hrefClean === rootPath) continue;
    const folderName = hrefClean.split('/').pop().toLowerCase();
    if (techFolders.includes(folderName)) continue;

    const calUrl = href.startsWith('http')
      ? href
      : `${new URL(rootUrl).origin}${href}`;

    calendars.push({ name: decodeURIComponent(name), url: calUrl, href, isVEvent });
  }
  return calendars;
}

// Leitet die CalDAV-Root-URL aus einer Kalender-URL ab
// (z.B. .../calendars/USER/PRIVAT/  →  .../calendars/USER/)
function deriveCalDavRoot(calUrl) {
  const u = new URL(calUrl);
  const parts = u.pathname.replace(/\/$/, '').split('/');
  parts.pop();
  u.pathname = parts.join('/') + '/';
  return u.toString();
}

app.post('/accounts/calendar/discover', async (req, res) => {
  try {
    const { url, username, password } = req.body;
    const calendars = await discoverCalendarsAt(url, username, password);
    res.json(calendars);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Erneut nach Kalendern auf demselben Pfad scannen, ohne Credentials neu eingeben zu müssen
app.post('/accounts/calendar/rescan', async (req, res) => {
  try {
    const { calendar_id } = req.body;
    const cal = await queryOne('SELECT url, username, password FROM calendars WHERE id = ?', [calendar_id]);
    if (!cal) return res.status(404).json({ error: 'Kalender nicht gefunden' });
    const rootUrl = deriveCalDavRoot(cal.url);
    const calendars = await discoverCalendarsAt(rootUrl, cal.username, cal.password);
    res.json({ root_url: rootUrl, calendars });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Neuen Kalender mit den Credentials eines bestehenden anlegen (Re-Scan-Workflow)
app.post('/accounts/calendar/from-existing', async (req, res) => {
  try {
    const { source_id, label, url, color } = req.body;
    const src = await queryOne('SELECT username, password FROM calendars WHERE id = ?', [source_id]);
    if (!src) return res.status(404).json({ error: 'Quell-Kalender nicht gefunden' });
    const { testCalDav } = await import('./caldav.js');
    await testCalDav(url, src.username, src.password);
    const result = await query(
      'INSERT INTO calendars (label, url, username, password, color) VALUES (?,?,?,?,?)',
      [label, url, src.username, src.password, color || '#8fb87a']
    );
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SYSTEM UPDATE ─────────────────────────────────────────────────────────────
import { createWriteStream, existsSync, copyFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const ALLOWED_FILES = {
  // Frontend – kein Neustart nötig
  'index.html':    { dest: '/opt/ki-assistent/frontend/index.html', restart: false },
  // Backend – Neustart nötig
  'server.js':     { dest: '/opt/ki-assistent/src/server.js',    restart: true },
  'ai.js':         { dest: '/opt/ki-assistent/src/ai.js',        restart: true },
  'imap.js':       { dest: '/opt/ki-assistent/src/imap.js',      restart: true },
  'caldav.js':     { dest: '/opt/ki-assistent/src/caldav.js',    restart: true },
  'nextcloud.js':  { dest: '/opt/ki-assistent/src/nextcloud.js', restart: true },
  'pushover.js':   { dest: '/opt/ki-assistent/src/pushover.js',  restart: true },
  'smtp.js':       { dest: '/opt/ki-assistent/src/smtp.js',      restart: true },
  'db.js':         { dest: '/opt/ki-assistent/src/db.js',        restart: true },
};

app.post('/system/upload', upload.single('file'), async (req, res) => {
  try {
    const filename = req.file?.originalname;
    if (!filename || !ALLOWED_FILES[filename]) {
      return res.status(400).json({ error: `Datei nicht erlaubt: ${filename}. Erlaubt: ${Object.keys(ALLOWED_FILES).join(', ')}` });
    }
    const { dest, restart } = ALLOWED_FILES[filename];

    // Backup anlegen
    const backup = dest + '.bak';
    if (existsSync(dest)) copyFileSync(dest, backup);

    // Neue Datei schreiben
    const { writeFileSync } = await import('fs');
    writeFileSync(dest, req.file.buffer);

    // Berechtigungen setzen
    await execAsync(`sudo chown assistant:assistant "${dest}"`).catch(() => {});

    if (restart) {
      // Syntax-Check
      try {
        await execAsync(`node --check "${dest}"`);
      } catch (syntaxErr) {
        // Rollback
        if (existsSync(backup)) copyFileSync(backup, dest);
        return res.status(400).json({ error: `Syntax-Fehler – Rollback: ${syntaxErr.message}` });
      }
      // Neustart nach kurzer Verzögerung
      setTimeout(() => execAsync('/usr/local/bin/ki-restart').catch(() => {}), 1000); // sudo bleibt für restart
      res.json({ ok: true, filename, restart: true, message: 'Datei gespeichert – Server startet neu…' });
    } else {
      res.json({ ok: true, filename, restart: false, message: 'Frontend aktualisiert – sofort aktiv.' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/system/restart', async (req, res) => {
  res.json({ ok: true, message: 'Server startet neu…' });
  setTimeout(() => execAsync('/usr/local/bin/ki-restart').catch(() => {}), 500);
});

app.get('/system/log', async (req, res) => {
  try {
    const { stdout } = await execAsync('journalctl -u ki-assistent -n 30 --no-pager --output=short');
    res.json({ log: stdout });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BODY NACHLADEN ────────────────────────────────────────────────────────────
app.post('/emails/:id/body-v2', async (req, res) => {
  try {
    const email = await queryOne(`
      SELECT e.*, a.host, a.port, a.username, a.password, a.tls
      FROM emails e JOIN email_accounts a ON a.id = e.account_id
      WHERE e.id = ?
    `, [req.params.id]);
    if (!email) return res.status(404).json({ error: 'Nicht gefunden' });

    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');

    const client = new ImapFlow({
      host: email.host, port: email.port, secure: !!email.tls,
      auth: { user: email.username, pass: email.password },
      logger: false, socketTimeout: 20000, connectionTimeout: 15000,
      disableAutoIdle: true,
    });
    client.on('error', () => {});
    await client.connect();

    let bodyText = '';
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uid = parseInt(email.uid);
        for await (const msg of client.fetch(
          { uid: `${uid}:${uid}` },
          { source: true },
          { uid: true }
        )) {
          const parsed = await simpleParser(msg.source);
          bodyText = (parsed.text || '').slice(0, 10000);
          if (!bodyText && parsed.html) {
            bodyText = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
          }
        }
      } finally { lock.release(); }
    } finally { try { await client.logout(); } catch(e) {} }

    if (bodyText) {
      await query('UPDATE emails SET body_text = ? WHERE id = ?', [bodyText, email.id]);
      res.json({ body: bodyText });
    } else {
      res.json({ body: null, message: 'Kein Textinhalt gefunden' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GIT UPDATE ────────────────────────────────────────────────────────────────
app.post('/system/git-pull', async (req, res) => {
  try {
    const { stdout, stderr } = await execAsync(
      'git -c safe.directory=/opt/ki-assistent -C /opt/ki-assistent pull origin main',
      { timeout: 30000 }
    );
    const changed = !stdout.includes('Already up to date.');
    res.json({ ok: true, output: stdout + stderr, changed });
    if (changed) {
      setTimeout(() => execAsync('/usr/local/bin/ki-restart').catch(() => {}), 2000);
    }
  } catch (e) {
    res.status(500).json({ error: e.message, detail: e.stderr || e.stdout || '' });
  }
});
