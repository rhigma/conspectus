import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/assistant.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    -- IMAP-Konten
    CREATE TABLE IF NOT EXISTS email_accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      host        TEXT NOT NULL,
      port        INTEGER NOT NULL DEFAULT 993,
      username    TEXT NOT NULL,
      password    TEXT NOT NULL,
      tls         INTEGER NOT NULL DEFAULT 1,
      color       TEXT NOT NULL DEFAULT '#d4a853',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Kalender (CalDAV / WebDAV)
    CREATE TABLE IF NOT EXISTS calendars (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL,
      url         TEXT NOT NULL,
      username    TEXT NOT NULL,
      password    TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#8fb87a',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Gecachte E-Mails (letzte 200 pro Konto)
    CREATE TABLE IF NOT EXISTS emails (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      uid         TEXT NOT NULL,
      message_id  TEXT,
      from_name   TEXT,
      from_email  TEXT,
      subject     TEXT,
      body_text   TEXT,
      date        TEXT,
      unread      INTEGER NOT NULL DEFAULT 1,
      flagged     INTEGER NOT NULL DEFAULT 0,
      synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, uid)
    );

    -- Gecachte Kalendereinträge
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      uid         TEXT NOT NULL,
      title       TEXT,
      start_time  TEXT,
      end_time    TEXT,
      location    TEXT,
      description TEXT,
      all_day     INTEGER NOT NULL DEFAULT 0,
      synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(calendar_id, uid)
    );

    -- Notizen (manuell + aus Handschrift-OCR)
    CREATE TABLE IF NOT EXISTS notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'handwriting' | 'ai'
      tags        TEXT,                            -- JSON-Array als String
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Chat-Verlauf
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role        TEXT NOT NULL,   -- 'user' | 'assistant'
      content     TEXT NOT NULL,
      model       TEXT,
      tokens_in   INTEGER,
      tokens_out  INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Konfiguration (Key-Value)
    CREATE TABLE IF NOT EXISTS config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sync-Log
    CREATE TABLE IF NOT EXISTS sync_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,   -- 'email' | 'calendar'
      account_id  INTEGER,
      status      TEXT NOT NULL,   -- 'ok' | 'error'
      message     TEXT,
      duration_ms INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

export function getConfig(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setConfig(key, value) {
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}
