import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db.js';
import { getEmailContext } from './imap.js';
import { getCalendarContext } from './caldav.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_FAST  = process.env.MODEL_FAST  || 'claude-haiku-4-5-20251001';
const MODEL_SMART = process.env.MODEL_SMART || 'claude-sonnet-4-6';

/** Baut den System-Prompt mit aktuellem Kontext */
function buildSystemPrompt() {
  const db = getDb();
  const now = new Date().toLocaleString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const accounts  = db.prepare('SELECT label, email FROM email_accounts WHERE active = 1').all();
  const calendars = db.prepare('SELECT label FROM calendars WHERE active = 1').all();
  const notes     = db.prepare('SELECT title, content, tags, created_at FROM notes ORDER BY updated_at DESC LIMIT 10').all();

  const emailCtx    = getEmailContext(15);
  const calendarCtx = getCalendarContext(7);

  const noteCtx = notes.length
    ? '\n## Notizen\n' + notes.map(n =>
        `- "${n.title}" (${n.created_at.slice(0,10)}): ${n.content.slice(0,200)}`
      ).join('\n')
    : '\n## Notizen\nKeine Notizen vorhanden.';

  return `Du bist ein persönlicher KI-Assistent für Selbstorganisation. Antworte immer auf Deutsch.
Heute ist ${now}.

## Konfigurierte Konten
E-Mail: ${accounts.map(a => `${a.label} <${a.email}>`).join(', ') || 'keine'}
Kalender: ${calendars.map(c => c.label).join(', ') || 'keine'}

${emailCtx}
${calendarCtx}
${noteCtx}

## Deine Fähigkeiten
- E-Mails zusammenfassen, priorisieren, nach Absendern/Themen suchen
- Termine im Überblick behalten, Konflikte erkennen
- Handgeschriebene Notizen (Bilder) digitalisieren und strukturieren
- Neue Notizen anlegen (antworte mit JSON: {"action":"create_note","title":"...","content":"...","tags":[]})
- Aufgaben aus E-Mails oder Notizen extrahieren
- Konten verwalten (antworte mit JSON: {"action":"add_account",...} oder {"action":"add_calendar",...})

Halte Antworten präzise und umsetzbar. Nutze **fett** für wichtige Begriffe.
Wenn du eine Aktion ausführen willst (Notiz anlegen etc.), antworte mit einem JSON-Block am Ende:
\`\`\`json
{"action": "...", ...}
\`\`\`
`;
}

/**
 * Sendet eine Nachricht an Claude und speichert den Verlauf.
 * @param {Array} history  - Bisheriger Verlauf [{role, content}]
 * @param {string} text    - Neue Nutzernachricht
 * @param {Array}  images  - Optional: [{base64, mediaType}]
 * @param {boolean} smart  - true = Sonnet, false = Haiku
 */
export async function chat({ history = [], text, images = [], smart = false }) {
  const db = getDb();
  const model = smart ? MODEL_SMART : MODEL_FAST;

  // Nachricht zusammenbauen
  const userContent = [];
  for (const img of images) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
    });
  }
  if (text) userContent.push({ type: 'text', text });

  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent.length === 1 && !images.length ? text : userContent }
  ];

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages,
  });

  const assistantText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // In DB speichern
  db.prepare(`INSERT INTO chat_messages (role, content, model, tokens_in, tokens_out)
              VALUES ('user', ?, ?, ?, ?)`).run(
    typeof userContent === 'string' ? text : JSON.stringify(userContent),
    model, response.usage.input_tokens, 0
  );
  db.prepare(`INSERT INTO chat_messages (role, content, model, tokens_in, tokens_out)
              VALUES ('assistant', ?, ?, ?, ?)`).run(
    assistantText, model, 0, response.usage.output_tokens
  );

  // Aktionen aus Antwort extrahieren
  const action = extractAction(assistantText);

  return {
    text: assistantText,
    model,
    tokens: { in: response.usage.input_tokens, out: response.usage.output_tokens },
    action,
  };
}

function extractAction(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

/** Führt eine KI-Aktion aus (Notiz anlegen etc.) */
export function executeAction(action) {
  if (!action) return null;
  const db = getDb();

  switch (action.action) {
    case 'create_note':
      const noteId = db.prepare(`
        INSERT INTO notes (title, content, source, tags)
        VALUES (?, ?, 'ai', ?)
      `).run(
        action.title || 'Neue Notiz',
        action.content || '',
        JSON.stringify(action.tags || [])
      ).lastInsertRowid;
      return { done: 'note_created', id: noteId };

    case 'add_account':
      db.prepare(`
        INSERT OR IGNORE INTO email_accounts (label, email, host, port, username, password, tls, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        action.label, action.email, action.host,
        action.port || 993, action.username, action.password,
        action.tls !== false ? 1 : 0,
        action.color || '#d4a853'
      );
      return { done: 'account_added' };

    case 'add_calendar':
      db.prepare(`
        INSERT OR IGNORE INTO calendars (label, url, username, password, color)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        action.label, action.url, action.username, action.password,
        action.color || '#8fb87a'
      );
      return { done: 'calendar_added' };

    default:
      return { done: 'unknown_action', action: action.action };
  }
}

/** Token-Statistik für Kostenübersicht */
export function getTokenStats() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT model,
           SUM(tokens_in)  as total_in,
           SUM(tokens_out) as total_out,
           COUNT(*)        as requests
    FROM chat_messages
    WHERE created_at >= ?
    GROUP BY model
  `).all(today + 'T00:00:00');

  // Grobe Kostenschätzung in USD
  const PRICES = {
    [MODEL_FAST]:  { in: 1.0, out: 5.0 },   // Haiku 4.5
    [MODEL_SMART]: { in: 3.0, out: 15.0 },  // Sonnet 4.6
  };

  return rows.map(r => {
    const p = PRICES[r.model] || { in: 3.0, out: 15.0 };
    const cost = (r.total_in / 1_000_000) * p.in + (r.total_out / 1_000_000) * p.out;
    return { ...r, cost_usd: Math.round(cost * 10000) / 10000 };
  });
}
