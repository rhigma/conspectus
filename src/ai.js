import Anthropic from '@anthropic-ai/sdk';
import { query, queryOne } from './db.js';
import { getEmailContext } from './imap.js';
import { vorgangOrdner, taskAnlegen } from './nextcloud.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL_FAST  = process.env.MODEL_FAST  || 'claude-haiku-4-5-20251001';
const MODEL_SMART = process.env.MODEL_SMART || 'claude-sonnet-4-6';

// ── System-Prompt ─────────────────────────────────────────────────────────────

async function buildSystemPrompt() {
  const now = new Date().toLocaleString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  // Offene Vorgänge
  const vorgaenge = await query(`
    SELECT v.*, 
      (SELECT COUNT(*) FROM delegationen d WHERE d.vorgang_id = v.id AND d.status = 'offen') as offene_delegationen,
      (SELECT COUNT(*) FROM vorgang_eintraege e WHERE e.vorgang_id = v.id) as eintraege
    FROM vorgaenge v
    WHERE v.status != 'abgeschlossen'
    ORDER BY v.prioritaet ASC, v.deadline ASC
    LIMIT 20
  `);

  // Überfällige Delegationen
  const ueberfaellig = await query(`
    SELECT d.*, v.titel as vorgang_titel
    FROM delegationen d
    JOIN vorgaenge v ON v.id = d.vorgang_id
    WHERE d.status = 'offen' AND d.deadline < CURDATE()
    ORDER BY d.deadline ASC
    LIMIT 10
  `);

  // Termine nächste 7 Tage
  const termine = await query(`
    SELECT e.title, e.start_time, e.location, v.titel as vorgang_titel
    FROM events e
    LEFT JOIN vorgaenge v ON v.id = e.vorgang_id
    WHERE e.start_time >= NOW() AND e.start_time <= DATE_ADD(NOW(), INTERVAL 7 DAY)
    ORDER BY e.start_time ASC
    LIMIT 15
  `);

  const emailCtx = await getEmailContext(6);

  const vorgangCtx = vorgaenge.length
    ? '\n## Offene Vorgänge\n' + vorgaenge.map(v => {
        const dl = v.deadline ? ` | Deadline: ${new Date(v.deadline).toLocaleDateString('de-DE')}` : '';
        const prio = ['', '🔴 Hoch', '🟡 Mittel', '🟢 Niedrig'][v.prioritaet] || '';
        return `- #${v.id} ${prio} **${v.titel}** [${v.status}]${dl} | ${v.offene_delegationen} offene Delegationen`;
      }).join('\n')
    : '\n## Vorgänge\nKeine offenen Vorgänge.';

  const delegCtx = ueberfaellig.length
    ? '\n## Überfällige Delegationen\n' + ueberfaellig.map(d =>
        `- ${d.an_name}: "${d.aufgabe}" (Vorgang: ${d.vorgang_titel}, fällig: ${new Date(d.deadline).toLocaleDateString('de-DE')})`
      ).join('\n')
    : '';

  const termineCtx = termine.length
    ? '\n## Termine (nächste 7 Tage)\n' + termine.map(t => {
        const dt = new Date(t.start_time).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        return `- ${dt}: ${t.title}${t.location ? ' @ ' + t.location : ''}${t.vorgang_titel ? ' [' + t.vorgang_titel + ']' : ''}`;
      }).join('\n')
    : '';

  return `Du bist der persönliche KI-Assistent von ${process.env.OWNER_NAME || "der Schulleitung"}. Heute ist ${now}.

Du arbeitest vorgangszentriert: Alle Informationen werden Vorgängen zugeordnet. 
Vorgänge haben Namen wie "Vera 3 2026", "Brandschutzbegehung 2026", "Dienstliche Beurteilung Müller".

## Delegations-Personen
- [PERSON_1] (Sekretariat)
- [PERSON_2] (eFöB)
- [OWNER] (selbst)
${vorgangCtx}
${delegCtx}
${termineCtx}
${emailCtx}

## Deine Fähigkeiten
Du kannst Aktionen auslösen indem du am Ende deiner Antwort einen JSON-Block einfügst:

Vorgang anlegen:
\`\`\`json
{"action":"vorgang_anlegen","titel":"...","typ":"personal|behoerde|veranstaltung|planung|sonstiges","prioritaet":1,"deadline":"2026-06-01","beschreibung":"..."}
\`\`\`

E-Mail einem Vorgang zuordnen:
\`\`\`json
{"action":"email_zuordnen","email_id":123,"vorgang_id":5}
\`\`\`

Delegation anlegen:
\`\`\`json
{"action":"delegation_anlegen","vorgang_id":5,"an_name":"[PERSON_1]","an_rolle":"sekretariat","aufgabe":"...","deadline":"2026-05-15"}
\`\`\`

Notiz zu Vorgang:
\`\`\`json
{"action":"notiz_anlegen","vorgang_id":5,"titel":"...","inhalt":"..."}
\`\`\`

Antworte immer auf Deutsch. Sei präzise und direkt. Nutze **fett** für Wichtiges.
Bei Vorgangs-Vorschlägen: nenne den Vorgang immer beim Namen aus dem Schema "Thema + Jahr/Datum".`;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export async function chat({ history = [], text, images = [], smart = false }) {
  const model = (images.length > 0 || smart) ? MODEL_SMART : MODEL_FAST;

  const userContent = [];
  for (const img of images) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  }
  if (text) userContent.push({ type: 'text', text });

  const messages = [
    ...history.slice(-12).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent.length === 1 && !images.length ? text : userContent },
  ];

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: await buildSystemPrompt(),
    messages,
  });

  const assistantText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  // Verlauf speichern
  await query(
    'INSERT INTO chat_messages (role, content, model, tokens_in, tokens_out) VALUES (?,?,?,?,?)',
    ['user', typeof userContent === 'string' ? text : JSON.stringify(userContent), model, response.usage.input_tokens, 0]
  );
  await query(
    'INSERT INTO chat_messages (role, content, model, tokens_in, tokens_out) VALUES (?,?,?,?,?)',
    ['assistant', assistantText, model, 0, response.usage.output_tokens]
  );

  const action = extractAction(assistantText);
  let actionResult = null;
  if (action) actionResult = await executeAction(action);

  return {
    text: assistantText,
    model,
    tokens: { in: response.usage.input_tokens, out: response.usage.output_tokens },
    action,
    actionResult,
  };
}

// ── E-Mail-Einordnung ─────────────────────────────────────────────────────────

export async function emailEinordnen(email) {
  const vorgaenge = await query(
    'SELECT id, titel, typ FROM vorgaenge WHERE status != ? ORDER BY updated_at DESC LIMIT 30',
    ['abgeschlossen']
  );

  const prompt = `Du bist ein Assistent für Schulleiter [OWNER].

Analysiere diese E-Mail und entscheide:
1. Gehört sie zu einem bestehenden Vorgang? Wenn ja, welchem?
2. Sollte ein neuer Vorgang angelegt werden? Wenn ja, wie heißt er (Schema: "Thema Jahr" oder "Thema Datum")?
3. Ist die E-Mail unwichtig / Spam / Newsletter? Dann "ignorieren".
4. Extrahiere 2–4 Schlagworte (Substantive, deutsch, z.B. "Brandschutz", "Stundenplan", "Elternabend", "Personal").
5. Bewerte die Dringlichkeit: "dringend" (Handlungsbedarf heute/diese Woche), "normal" (reguläre Schulkommunikation), "info" (zur Kenntnis, kein Handlungsbedarf).

Bestehende Vorgänge:
${vorgaenge.map(v => `- #${v.id}: ${v.titel} [${v.typ}]`).join('\n') || 'Keine'}

E-Mail:
Von: ${email.from_name || email.from_email}
Betreff: ${email.subject}
Datum: ${email.date ? new Date(email.date).toLocaleString('de-DE') : '?'}
Inhalt: ${(email.body_text || '').slice(0, 800)}

Antworte NUR mit JSON:
{"einordnung":"vorgang_zuordnen"|"vorgang_anlegen"|"ignorieren","vorgang_id":null,"vorgang_titel":"...","begruendung":"...","prioritaet":1|2|3,"schlagworte":["Wort1","Wort2"],"ki_prioritaet":"dringend"|"normal"|"info"}`;

  const response = await client.messages.create({
    model: MODEL_FAST,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const text = response.content[0].text.trim().replace(/```json|```/g, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Notiz-Analyse (reMarkable / Foto) ─────────────────────────────────────────

export async function notizAnalysieren(imageBase64, mediaType = 'image/jpeg') {
  // PDF → PNG konvertieren
  if (mediaType === 'application/pdf') {
    try {
      const { execSync, spawnSync } = await import('child_process');
      const { writeFileSync: wfs, readFileSync: rfs, unlinkSync, existsSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      
      const tmpPdf = join(tmpdir(), `boox-${Date.now()}.pdf`);
      const tmpBase = join(tmpdir(), `boox-${Date.now()}`);
      
      wfs(tmpPdf, Buffer.from(imageBase64, 'base64'));
      
      // Erste Seite als PNG exportieren (150 DPI)
      spawnSync('pdftoppm', ['-r', '150', '-png', '-l', '3', tmpPdf, tmpBase]);
      
      // Erste verfügbare Seite laden – pdftoppm erzeugt -1.png, -2.png etc.
      let pngBase64 = null;
      const { readdirSync } = await import('fs');
      const { dirname, basename } = await import('path');
      const tmpDir = dirname(tmpBase);
      const tmpPrefix = basename(tmpBase);
      const allFiles = readdirSync(tmpDir)
        .filter(fn => fn.startsWith(tmpPrefix) && fn.endsWith('.png'))
        .sort();
      if (allFiles.length > 0) {
        const firstPng = join(tmpDir, allFiles[0]);
        pngBase64 = rfs(firstPng).toString('base64');
        allFiles.forEach(fn => { try { unlinkSync(join(tmpDir, fn)); } catch(e) {} });
      }
      try { unlinkSync(tmpPdf); } catch(e) {}
      
      if (pngBase64) {
        imageBase64 = pngBase64;
        mediaType = 'image/png';
      } else {
        throw new Error('PDF-Konvertierung fehlgeschlagen');
      }
    } catch(e) {
      console.error('[notizAnalysieren] PDF-Konvertierung:', e.message);
      throw e;
    }
  }
  const vorgaenge = await query(
    'SELECT id, titel FROM vorgaenge WHERE status != ? ORDER BY updated_at DESC LIMIT 20',
    ['abgeschlossen']
  );

  const response = await client.messages.create({
    model: MODEL_SMART,
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: `Du analysierst eine handgeschriebene Notiz des Schulleiters.

Bestehende Vorgänge:
${vorgaenge.map(v => `- #${v.id}: ${v.titel}`).join('\n') || 'Keine'}

Bitte:
1. Transkribiere den handgeschriebenen Text vollständig
2. Erkenne zu welchem Vorgang die Notiz gehört (oder ob ein neuer Vorgang angelegt werden soll)
3. Extrahiere: Aufgaben, Delegationen, Termine

Antworte mit JSON:
{
  "transkription": "...",
  "vorgang_id": null,
  "vorgang_titel": "...",
  "aufgaben": ["..."],
  "delegationen": [{"an":"[PERSON_1]","aufgabe":"...","deadline":"2026-05-15"}],
  "termine": [{"titel":"...","datum":"2026-05-07","uhrzeit":"14:00"}],
  "zusammenfassung": "..."
}` }
      ],
    }],
  });

  try {
    const text = response.content[0].text.trim().replace(/```json|```/g, '');
    return JSON.parse(text);
  } catch {
    return { transkription: response.content[0].text, fehler: 'JSON-Parse fehlgeschlagen' };
  }
}

// ── Morgen-Briefing ───────────────────────────────────────────────────────────

export async function morgenbriefing() {
  const systemPrompt = await buildSystemPrompt();
  const heute = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  const response = await client.messages.create({
    model: MODEL_FAST,
    max_tokens: 1200,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Erstelle das Morgen-Briefing für ${heute}. 

Struktur:
1. **Heute auf dem Plan** – Termine des Tages
2. **Dringende Vorgänge** – Priorität Hoch oder Deadline diese Woche
3. **Überfällige Delegationen** – was ist offen und überfällig?
4. **Neue unzugeordnete E-Mails** – kurze Übersicht
5. **Empfehlung** – 1-2 Sätze: womit anfangen?

Sei prägnant. Keine langen Erklärungen.`,
    }],
  });

  const text = response.content[0].text;

  // Als Notiz speichern
  const vorgangCtx = null;
  await query(
    'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt) VALUES (?,?,?,?)',
    [null, 'ki_analyse', `Briefing ${heute}`, text]
  );

  return text;
}

// ── Aktionen ausführen ────────────────────────────────────────────────────────

function extractAction(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

export async function executeAction(action) {
  if (!action?.action) return null;

  switch (action.action) {

    case 'vorgang_anlegen': {
      const ncPfad = await vorgangOrdner(action.titel);
      const result = await query(
        `INSERT INTO vorgaenge (titel, typ, prioritaet, deadline, beschreibung, nc_ordner)
         VALUES (?,?,?,?,?,?)`,
        [action.titel, action.typ || 'sonstiges', action.prioritaet || 2,
         action.deadline || null, action.beschreibung || null, ncPfad]
      );
      return { done: 'vorgang_angelegt', id: result.insertId, titel: action.titel, nc_ordner: ncPfad };
    }

    case 'email_zuordnen': {
      await query('UPDATE emails SET vorgang_id = ? WHERE id = ?', [action.vorgang_id, action.email_id]);
      // Chronologie-Eintrag
      const email = await queryOne('SELECT * FROM emails WHERE id = ?', [action.email_id]);
      if (email) {
        await query(
          'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, ref_id) VALUES (?,?,?,?,?)',
          [action.vorgang_id, 'email', email.subject, email.body_text, action.email_id]
        );
      }
      return { done: 'email_zugeordnet', email_id: action.email_id, vorgang_id: action.vorgang_id };
    }

    case 'delegation_anlegen': {
      const person = await queryOne(
        'SELECT id FROM delegations_personen WHERE name = ?', [action.an_name]
      );
      const result = await query(
        `INSERT INTO delegationen (vorgang_id, person_id, an_name, an_rolle, aufgabe, deadline)
         VALUES (?,?,?,?,?,?)`,
        [action.vorgang_id, person?.id || null, action.an_name, action.an_rolle || 'sonstiges',
         action.aufgabe, action.deadline || null]
      );
      // Auch als Nextcloud Task anlegen
      await taskAnlegen({
        titel: `${action.aufgabe} (${action.an_name})`,
        faellig: action.deadline,
        vorgang: action.vorgang_titel,
      });
      // Chronologie
      await query(
        'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt, ref_id) VALUES (?,?,?,?,?)',
        [action.vorgang_id, 'delegation', `Delegation an ${action.an_name}`, action.aufgabe, result.insertId]
      );
      return { done: 'delegation_angelegt', id: result.insertId };
    }

    case 'notiz_anlegen': {
      const result = await query(
        'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt) VALUES (?,?,?,?)',
        [action.vorgang_id, 'notiz', action.titel, action.inhalt]
      );
      return { done: 'notiz_angelegt', id: result.insertId };
    }

    default:
      return { done: 'unbekannte_aktion', action: action.action };
  }
}

export async function getTokenStats() {
  const heute = new Date().toISOString().slice(0, 10);
  const rows = await query(
    `SELECT model,
            SUM(tokens_in) as total_in,
            SUM(tokens_out) as total_out,
            COUNT(*) as requests
     FROM chat_messages
     WHERE DATE(created_at) = ?
     GROUP BY model`,
    [heute]
  );
  const PRICES = { [MODEL_FAST]: { in: 1.0, out: 5.0 }, [MODEL_SMART]: { in: 3.0, out: 15.0 } };
  return rows.map(r => {
    const p = PRICES[r.model] || { in: 3.0, out: 15.0 };
    const cost = (r.total_in / 1e6) * p.in + (r.total_out / 1e6) * p.out;
    return { ...r, cost_usd: Math.round(cost * 10000) / 10000 };
  });
}
