import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import cron from 'node-cron';
import { getDb } from './db.js';
import { syncAllAccounts, getEmailContext } from './imap.js';
import { syncAllCalendars, getCalendarContext } from './caldav.js';
import { chat, executeAction, getTokenStats } from './ai.js';

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.API_SECRET;

// ── Middleware ────────────────────────────────────────────────────────────────
// Frontend läuft auf demselben Server (same-origin)
app.use(cors({ origin: false }));

// Statisches Frontend ausliefern
app.use(express.static(path.join(__dirname, "../frontend")));
app.use(express.json({ limit: '10mb' }));

// Einfache API-Key-Authentifizierung
app.use((req, res, next) => {
  // Health-Check ohne Auth
  if (req.path === '/health') return next();

  const key = req.headers['x-api-key'] || req.query.key;
  if (SECRET && key !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post('/chat', upload.array('images', 5), async (req, res) => {
  try {
    const { text, history = [], smart } = req.body;
    const parsedHistory = typeof history === 'string' ? JSON.parse(history) : history;

    // Bilder aus Multipart
    const images = (req.files || []).map(f => ({
      base64: f.buffer.toString('base64'),
      mediaType: f.mimetype,
    }));

    // Wenn Bilder dabei: immer Sonnet
    const useSmartModel = images.length > 0 || smart === 'true' || smart === true;

    const result = await chat({
      history: parsedHistory,
      text,
      images,
      smart: useSmartModel,
    });

    // Aktionen ausführen
    if (result.action) {
      result.actionResult = executeAction(result.action);
    }

    res.json(result);
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Chat-Verlauf ──────────────────────────────────────────────────────────────
app.get('/chat/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const rows = getDb().prepare(`
    SELECT role, content, model, created_at
    FROM chat_messages ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  res.json(rows.reverse());
});

// ── E-Mail-Konten ─────────────────────────────────────────────────────────────
app.get('/accounts/email', (req, res) => {
  const rows = getDb().prepare(
    'SELECT id, label, email, host, port, tls, color, active FROM email_accounts'
  ).all();
  res.json(rows);
});

app.post('/accounts/email', (req, res) => {
  const { label, email, host, port, username, password, tls, color } = req.body;
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO email_accounts (label, email, host, port, username, password, tls, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(label, email, host, port || 993, username, password, tls !== false ? 1 : 0, color || '#d4a853');
  res.json({ id: info.lastInsertRowid });
});

app.delete('/accounts/email/:id', (req, res) => {
  getDb().prepare('DELETE FROM email_accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Kalender ──────────────────────────────────────────────────────────────────
app.get('/accounts/calendar', (req, res) => {
  const rows = getDb().prepare(
    'SELECT id, label, url, color, active FROM calendars'
  ).all();
  res.json(rows);
});

app.post('/accounts/calendar', (req, res) => {
  const { label, url, username, password, color } = req.body;
  const info = getDb().prepare(`
    INSERT INTO calendars (label, url, username, password, color)
    VALUES (?, ?, ?, ?, ?)
  `).run(label, url, username, password, color || '#8fb87a');
  res.json({ id: info.lastInsertRowid });
});

app.delete('/accounts/calendar/:id', (req, res) => {
  getDb().prepare('DELETE FROM calendars WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── E-Mails ───────────────────────────────────────────────────────────────────
app.get('/emails', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const account = req.query.account;
  let query = `
    SELECT e.*, a.label as account_label, a.color as account_color
    FROM emails e JOIN email_accounts a ON a.id = e.account_id
  `;
  const params = [];
  if (account) { query += ' WHERE a.id = ?'; params.push(account); }
  query += ' ORDER BY e.date DESC LIMIT ?';
  params.push(limit);
  res.json(getDb().prepare(query).all(...params));
});

// ── Events ────────────────────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const from = req.query.from || new Date().toISOString();
  const until = new Date();
  until.setDate(until.getDate() + days);

  const rows = getDb().prepare(`
    SELECT e.*, c.label as cal_label, c.color as cal_color
    FROM events e JOIN calendars c ON c.id = e.calendar_id
    WHERE e.start_time >= ? AND e.start_time <= ?
    ORDER BY e.start_time ASC LIMIT 100
  `).all(from, until.toISOString());
  res.json(rows);
});

// ── Notizen ───────────────────────────────────────────────────────────────────
app.get('/notes', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM notes ORDER BY updated_at DESC').all());
});

app.post('/notes', (req, res) => {
  const { title, content, source, tags } = req.body;
  const info = getDb().prepare(`
    INSERT INTO notes (title, content, source, tags) VALUES (?, ?, ?, ?)
  `).run(title, content, source || 'manual', JSON.stringify(tags || []));
  res.json({ id: info.lastInsertRowid });
});

app.put('/notes/:id', (req, res) => {
  const { title, content, tags } = req.body;
  getDb().prepare(`
    UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?
  `).run(title, content, JSON.stringify(tags || []), req.params.id);
  res.json({ ok: true });
});

app.delete('/notes/:id', (req, res) => {
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Sync manuell auslösen ─────────────────────────────────────────────────────
app.post('/sync', async (req, res) => {
  try {
    const [emailResults, calResults] = await Promise.allSettled([
      syncAllAccounts(),
      syncAllCalendars(),
    ]);
    res.json({
      email:    emailResults.status === 'fulfilled'  ? emailResults.value  : { error: emailResults.reason?.message },
      calendar: calResults.status   === 'fulfilled'  ? calResults.value    : { error: calResults.reason?.message },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
  const db = getDb();
  res.json({
    emails:    db.prepare('SELECT COUNT(*) as n FROM emails').get().n,
    unread:    db.prepare('SELECT COUNT(*) as n FROM emails WHERE unread = 1').get().n,
    events:    db.prepare('SELECT COUNT(*) as n FROM events').get().n,
    notes:     db.prepare('SELECT COUNT(*) as n FROM notes').get().n,
    tokens:    getTokenStats(),
    lastSync:  db.prepare("SELECT MAX(created_at) as t FROM sync_log WHERE status = 'ok'").get()?.t,
  });
});

// ── Sync-Log ──────────────────────────────────────────────────────────────────
app.get('/sync/log', (req, res) => {
  const rows = getDb().prepare(
    'SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 50'
  ).all();
  res.json(rows);
});

// ── Automatischer Sync per Cron ───────────────────────────────────────────────
const interval = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 5;
if (!global._cronStarted) {
  global._cronStarted = true;
  cron.schedule(`*/${interval} * * * *`, async () => {
    console.log(`[${new Date().toISOString()}] Auto-Sync...`);
    try {
      await Promise.allSettled([syncAllAccounts(), syncAllCalendars()]);
      console.log('Sync OK');
    } catch (err) {
      console.error('Sync error:', err.message);
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`KI-Assistent Backend läuft auf http://127.0.0.1:${PORT}`);
  console.log(`Sync alle ${interval} Minuten`);
});

// Verhindert dass unhandled errors den Prozess killen
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
