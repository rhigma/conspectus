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
import { ncMkdir, neueRemarkableNotizen, remarkableVerarbeitet, ncDownload, vorgangOrdner } from './nextcloud.js';
import { createCalDavEvent, deleteCalDavEvent } from './caldav.js';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const PORT   = process.env.PORT || 3001;
const SECRET = process.env.API_SECRET;

app.use(cors({ origin: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (SECRET && key !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
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
async function booxNotizVerarbeiten(pfad) {
  const buffer = await ncDownload(pfad);
  const analyse = await notizAnalysieren(buffer.toString('base64'), 'application/pdf');

  // Vorgang-ID auflösen: direkt, per Titelsuche, oder neu anlegen
  let vorgangId = analyse.vorgang_id ? parseInt(analyse.vorgang_id) : null;
  if (!vorgangId && analyse.vorgang_titel) {
    const existing = await queryOne(
      'SELECT id FROM vorgaenge WHERE titel LIKE ? LIMIT 1',
      [`%${analyse.vorgang_titel}%`]
    );
    if (existing) {
      vorgangId = existing.id;
    } else {
      const ncPfad = await vorgangOrdner(analyse.vorgang_titel).catch(() => null);
      const result = await query(
        'INSERT INTO vorgaenge (titel, typ, beschreibung, nc_ordner) VALUES (?,?,?,?)',
        [analyse.vorgang_titel, 'sonstiges', `Aus Boox-Notiz: ${pfad.split('/').pop()}`, ncPfad]
      );
      vorgangId = result.insertId;
    }
  }

  // Chronologie-Eintrag
  await query(
    'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, datei_pfad) VALUES (?,?,?,?,?)',
    [vorgangId, 'notiz', `Boox: ${pfad.split('/').pop()}`, JSON.stringify(analyse), pfad]
  );

  // Termine aus Boox-Analyse als events-Einträge anlegen
  let terminCount = 0;
  for (const t of analyse.termine || []) {
    try {
      const startDt = t.uhrzeit
        ? new Date(`${t.datum}T${t.uhrzeit}:00`)
        : new Date(t.datum);
      if (isNaN(startDt.getTime())) continue;
      const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
      const uid = `boox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await query(
        'INSERT INTO events (vorgang_id, uid, title, start_time, end_time, all_day) VALUES (?,?,?,?,?,?)',
        [vorgangId, uid, t.titel, startDt.toISOString(), endDt.toISOString(), t.uhrzeit ? 0 : 1]
      );
      terminCount++;
    } catch (e) { console.error('[Boox] Termin-Fehler:', e.message); }
  }

  // Delegationen aus Boox-Analyse anlegen
  let delegCount = 0;
  for (const d of analyse.delegationen || []) {
    try {
      const person = await queryOne(
        'SELECT id, rolle FROM delegations_personen WHERE name = ? AND aktiv = 1',
        [d.an]
      );
      const result = await query(
        'INSERT INTO delegationen (vorgang_id, person_id, an_name, an_rolle, aufgabe, deadline) VALUES (?,?,?,?,?,?)',
        [vorgangId, person?.id || null, d.an, person?.rolle || 'sonstiges', d.aufgabe, d.deadline || null]
      );
      await query(
        'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, ref_id) VALUES (?,?,?,?,?)',
        [vorgangId, 'delegation', `Delegation an ${d.an}`, d.aufgabe, result.insertId]
      );
      delegCount++;
    } catch (e) { console.error('[Boox] Delegation-Fehler:', e.message); }
  }

  await remarkableVerarbeitet(pfad);
  console.log(`[Boox] ${pfad.split('/').pop()} → Vorgang #${vorgangId}, ${terminCount} Termine, ${delegCount} Delegationen`);
  return { pfad, vorgangId, termine: terminCount, delegationen: delegCount, analyse };
}

app.post('/boox/sync', async (req, res) => {
  try {
    const notizen = await neueRemarkableNotizen();
    const ergebnisse = [];
    for (const pfad of notizen) {
      ergebnisse.push(await booxNotizVerarbeiten(pfad));
    }
    res.json({ verarbeitet: ergebnisse.length, ergebnisse });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/boox/status', async (req, res) => {
  try {
    const eintraege = await query(
      `SELECT id, vorgang_id, titel, inhalt, datei_pfad, created_at
       FROM vorgang_eintraege WHERE titel LIKE 'Boox:%' ORDER BY created_at DESC LIMIT 5`
    );
    res.json(eintraege);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CRON ──────────────────────────────────────────────────────────────────────
const interval = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 5;
const briefingH = parseInt(process.env.BRIEFING_HOUR) || 6;
const briefingM = parseInt(process.env.BRIEFING_MINUTE) || 30;

if (!global._cronStarted) {
  global._cronStarted = true;

  // E-Mail-Sync
  cron.schedule(`*/${interval} * * * *`, async () => {
    console.log(`[${new Date().toISOString()}] Auto-Sync...`);
    try { await syncAllAccounts(); console.log('Sync OK'); }
    catch (e) { console.error('Sync Fehler:', e.message); }
  });

  // Morgen-Briefing
  cron.schedule(`${briefingM} ${briefingH} * * *`, async () => {
    console.log('[Briefing] Erstelle Morgen-Briefing...');
    try { await morgenbriefing(); console.log('[Briefing] OK'); }
    catch (e) { console.error('[Briefing] Fehler:', e.message); }
  });

  // INBOX-UID-Abgleich: außerhalb INBOX = erledigt (stündlich, Minute 45)
  cron.schedule('45 * * * *', async () => {
    try { await syncErledigtStatus(); }
    catch (e) { console.error('[IMAP] syncErledigtStatus Fehler:', e.message); }
  });

  // Boox-Notizen (stündlich zur vollen Stunde)
  cron.schedule('0 * * * *', async () => {
    try {
      const notizen = await neueRemarkableNotizen();
      for (const pfad of notizen) await booxNotizVerarbeiten(pfad);
    } catch (e) { /* Boox optional */ }
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
  await ncMkdir('/Vorgaenge').catch(() => {});
  await ncMkdir('/E-Mail-Anhänge').catch(() => {});
  await ncMkdir('/reMarkable').catch(() => {});
  await ncMkdir('/reMarkable/neu').catch(() => {});
  await ncMkdir('/reMarkable/verarbeitet').catch(() => {});

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`KI-Assistent v2 läuft auf http://127.0.0.1:${PORT}`);
    console.log(`Sync alle ${interval} Min. | Briefing ${briefingH}:${String(briefingM).padStart(2,'0')} Uhr`);
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
    const days = parseInt(req.query.days) || 14;
    const from = new Date().toISOString();
    const until = new Date();
    until.setDate(until.getDate() + days);
    const rows = await query(`
      SELECT e.*, c.label as cal_label, c.color as cal_color
      FROM events e JOIN calendars c ON c.id = e.calendar_id
      WHERE e.start_time >= ? AND e.start_time <= ?
      ORDER BY e.start_time ASC LIMIT 100
    `, [from, until.toISOString()]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/settings', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM settings');
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/settings/:key', async (req, res) => {
  try {
    await query(
      'INSERT INTO settings (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [req.params.key, req.body.value ?? null]
    );
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
    res.json({
      email_accounts: emailCount.n,
      calendars: calCount.n,
      personen: personCount.n,
      sync_interval: process.env.SYNC_INTERVAL_MINUTES || 5,
      briefing_time: `${process.env.BRIEFING_HOUR || 6}:${String(process.env.BRIEFING_MINUTE || 30).padStart(2,'0')}`,
      token_stats: tokenStats,
      nc_url: process.env.NC_URL,
      boox_pfad: '/onyx/GoColor7_2/Notizblöcke',
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
app.post('/accounts/calendar/discover', async (req, res) => {
  try {
    const { url, username, password } = req.body;
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

    const r = await fetch(url, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1', 'Content-Type': 'application/xml' },
      body,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();

    // Alle href + displayname Paare extrahieren
    const responses = [...xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)];
    const calendars = [];

    for (const [, block] of responses) {
      const href = block.match(/<d:href>([^<]+)<\/d:href>/)?.[1];
      const name = block.match(/<d:displayname>([^<]*)<\/d:displayname>/)?.[1] || '';
      const isCalendar = block.includes('caldav:calendar') || block.includes('c:calendar');
      const isVEvent = block.includes('VEVENT') || !block.includes('VTODO');

      if (!href || !name) continue;

      // Root-Ordner überspringen
      const rootPath = new URL(url).pathname.replace(/\/$/, '');
      const hrefClean = href.replace(/\/$/, '');
      if (hrefClean === rootPath) continue;

      // Technische Ordner überspringen (inbox, outbox, trashbin)
      const techFolders = ['inbox', 'outbox', 'trashbin'];
      const folderName = hrefClean.split('/').pop().toLowerCase();
      if (techFolders.includes(folderName)) continue;

      // Vollständige URL
      const calUrl = href.startsWith('http') ? href : `${process.env.NC_URL}${href}`;

      calendars.push({
        name: decodeURIComponent(name),
        url: calUrl,
        href,
        isVEvent,
      });
    }

    res.json(calendars);
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
