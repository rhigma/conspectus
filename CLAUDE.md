# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Conspectus is a self-hosted personal AI assistant for school administrators. It is process-centric (not email-centric), organizing work around *Vorgänge* (processes/cases) and integrating email, calendar, notes, delegations, and todos. The UI and much of the codebase is in German.

## Commands

```bash
# Development (file watch, auto-restart)
npm run dev

# Production
npm start
```

There is no build step, no linter, and no test framework. The frontend (`frontend/index.html`) is plain HTML/CSS/JS and requires no compilation.

**Deploy to production:**
```bash
bash scripts/deploy.sh
```
The script validates syntax, creates a rollback backup, restarts the systemd service (`ki-assistent`), and runs a health check.

**Backfill scripts (run once on VPS after deploy):**
```bash
node scripts/backfill-bodies.mjs          # Load body text for emails that had none
node scripts/backfill-ki-analyse.mjs      # Run AI keyword/priority analysis on old emails
```

## Architecture

### Backend (`src/`)

All HTTP endpoints live in `src/server.js` (Express). Authentication uses a single API key (`X-Api-Key` header). The server starts scheduled cron jobs on boot:

| Schedule | Job |
|---|---|
| Every 5 min | Email sync (IMAP) + AI analysis |
| Daily 06:30 | Morning briefing push notification |
| Daily 08:00 | Delegation reminders |
| Every 15 min | Calendar reminders + CalDAV sync |
| Hourly | Boox PDF sync from Nextcloud |

Each subsystem is a separate module:

- `src/db.js` — MariaDB connection pool + schema initialization. Tables: `vorgaenge`, `emails`, `delegationen`, `events`, `calendars`, `email_accounts`, `vorgang_eintraege`, `chat_messages`, `sync_log`, `settings` (key-value for runtime config), `todos`. Schema additions use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- `src/ai.js` — Claude API integration; routes requests to `claude-haiku-4-5-20251001` (fast: summaries, search, email analysis) or `claude-sonnet-4-6` (smart: vision/handwriting); dynamic system prompt includes open tasks, overdue delegations, next 7 days of events; AI can trigger JSON-encoded *actions* (create Vorgang, assign email, etc.); `emailEinordnen()` returns `{einordnung, vorgang_id, vorgang_titel, begruendung, prioritaet, schlagworte[], ki_prioritaet}`; `morgenbriefing()` saves to `chat_messages` (not `vorgang_eintraege`, which has `vorgang_id NOT NULL`).
- `src/imap.js` — Multi-account IMAP sync using two-pass approach: Pass 1 collects new UIDs via envelope fetch, Pass 2 fetches `{source:true}` per UID. This avoids the "connection busy" error when calling `download()` inside a `fetch()` loop. Also exports `moveToErledigt(account, uid)` for archiving.
- `src/caldav.js` — CalDAV sync with TZID-aware timezone parsing for Europe/Berlin. Also exports `createCalDavEvent(calendarId, {uid, title, start, end, description})` (HTTP PUT of VEVENT ICS) and `deleteCalDavEvent(calendarId, uid)` (HTTP DELETE, ignores 404). `formatIcalLocal(date)` converts a JS Date to `YYYYMMDDTHHMMSS` in Europe/Berlin timezone.
- `src/nextcloud.js` — WebDAV file storage; fetches Boox tablet PDFs, converts to PNG via `pdftoppm`, sends to Claude vision.
- `src/smtp.js` — Outbound email via Nodemailer.
- `src/pushover.js` — Push notifications via Pushover API. `getCredentials()` reads token/user from the `settings` table first, falls back to `process.env.PUSHOVER_TOKEN/USER`. Throws a descriptive error if credentials are missing.

### Frontend (`frontend/index.html`)

A single ~4500-line vanilla JS SPA (no framework, no build). Tabs: Dashboard, Vorgänge, E-Mails, KI-Assistent, Einstellungen. Uses CSS custom properties (`--ink`, `--accent`, etc.) and flexbox/grid.

**Dark mode:** CSS variables overridden in `[data-theme="dark"]` block. FOUC is prevented with an inline `<script>` in `<head>` that reads `localStorage` and sets the attribute before render. Toggle via `toggleDarkMode()`.

**Email view state:**
- `_emlDaten` — cached raw email array from API
- `_emlNurAktiv` — bool, whether to show only non-erledigt emails
- `_emlThema` — `null` (all) or a keyword string (filter by `ki_einordnung.schlagworte`)
- `tryParseKi(json)` — safely parses `ki_einordnung` JSON; returns null on failure

**Markdown rendering — `renderMd(t)`:**  
Block-level parser: accumulates `|`-lines for table detection, handles `###`/`##`/`#` headings, `- `/ `* ` unordered lists, `N. ` ordered lists, `---` HR, blank-line list/table closing. Inline: `**bold**`, `*italic*`, `` `code` ``, HTML-escaping. Used for briefing text and AI chat bubbles.

**Todos / Eisenhower Matrix:**
- `openVorgang()` fetches todos in parallel: `Promise.all([GET /vorgaenge/:id, GET /todos?vorgang_id=N])`
- `renderTodosCard(todos)` builds 2×2 Eisenhower HTML (Q1=wichtig+dringend, Q2=wichtig, Q3=dringend, Q4=neither)
- `loadDashTodos()` fetches `GET /todos?erledigt=0` for the dashboard matrix
- `dashTodoErledigt(id)` marks a todo done from the dashboard

**Vorgang status:**
- Status is rendered as `<select class="status-select">` calling `PATCH /vorgaenge/:id` with `{status}`
- CSS classes `.status-select.abgeschlossen/in_bearbeitung/wartet` color the select

**Key patterns:**
- `req(method, path, body)` — fetch wrapper that reads JSON error bodies (`r.error`, `r.detail`) and includes them in the thrown Error message
- All API calls use `X-Api-Key` header from `SECRET` constant
- Route order in `server.js` matters: `/emails/themen` must be registered before `/emails/:id`
- CSS class specificity: never use inline `display:flex` on view containers — it overrides `.view{display:none}` and breaks show/hide

### Configuration

All runtime configuration is via environment variables. Copy `.env.example` to `.env` before first run. Key variables: `PORT`, `DB_*`, `ANTHROPIC_API_KEY`, `NEXTCLOUD_*`, `PUSHOVER_*`, IMAP/SMTP credentials, sync intervals.

Pushover credentials can also be stored in the `settings` table (keys: `pushover_token`, `pushover_user`) — this takes precedence over `.env` and can be edited in the Settings UI.

The Todo target calendar is stored as `settings` key `todo_calendar_id`.

The project uses ES modules (`"type": "module"` in `package.json`); all imports must use ESM syntax.

### Database notes

- `mysql2` returns `result.insertId` directly on INSERT — do not destructure as `[result]`.
- The `emails` table has an `erledigt TINYINT NOT NULL DEFAULT 0` column and `ki_einordnung TEXT` (stores JSON: `{einordnung, schlagworte[], ki_prioritaet, ...}`). New columns are added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `db.js`.
- `GET /emails` returns `SELECT e.*` so `ki_einordnung` is always included.
- `settings` table: `key VARCHAR(100) PRIMARY KEY, value TEXT` — used for Pushover credentials, todo calendar, and other runtime config.
- `todos` table: `id, vorgang_id INT NOT NULL, titel, beschreibung, faellig_am DATETIME, wichtig TINYINT DEFAULT 1, dringend TINYINT DEFAULT 0, erledigt TINYINT DEFAULT 0, erledigt_am, event_uid, calendar_id, created_at`.

### Production environment

- VPS: Debian, systemd service named `ki-assistent`, runs as user `assistant`
- Nginx proxies `/api/` → Express (strips prefix); static files served by Express
- `git pull` must use `git -c safe.directory=/opt/ki-assistent -C /opt/ki-assistent pull origin main` to avoid "dubious ownership" errors when the repo is owned by a different user than the service account
- Restart via `/usr/local/bin/ki-restart` (setuid wrapper) because `systemd NoNewPrivileges` prevents `sudo`
