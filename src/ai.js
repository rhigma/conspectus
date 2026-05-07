import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { query, queryOne } from './db.js';
import { getEmailContext, moveToErledigt, moveToVorgangFolder, vorgangFolderPath } from './imap.js';
import { vorgangOrdner, taskAnlegen } from './nextcloud.js';
import { createCalDavEvent, deleteCalDavEvent } from './caldav.js';
import { sendReply } from './smtp.js';

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

  // Wiedervorlagen heute
  const wiedervorlagen = await query(`
    SELECT id, titel, wiedervorlage_am FROM vorgaenge
    WHERE wiedervorlage_am IS NOT NULL AND wiedervorlage_am <= CURDATE() AND status != 'abgeschlossen'
    ORDER BY wiedervorlage_am ASC LIMIT 10
  `);

  const emailCtx = await getEmailContext(6);

  // Offene Todos
  const offeneTodos = await query(`
    SELECT t.id, t.titel, t.wichtig, t.dringend, t.faellig_am, v.titel as vorgang_titel
    FROM todos t JOIN vorgaenge v ON v.id = t.vorgang_id
    WHERE t.erledigt = 0
    ORDER BY t.wichtig DESC, t.dringend DESC, t.faellig_am ASC
    LIMIT 15
  `);

  // Aktive Kalender
  const kalender = await query(`SELECT id, label FROM calendars WHERE active = 1 LIMIT 10`);

  const vorgangCtx = vorgaenge.length
    ? '\n## Offene Vorgänge\n' + vorgaenge.map(v => {
        const dl = v.deadline ? ` | Deadline: ${new Date(v.deadline).toLocaleDateString('de-DE')}` : '';
        const wv = v.wiedervorlage_am ? ` | Wiedervorlage: ${new Date(v.wiedervorlage_am).toLocaleDateString('de-DE')}` : '';
        const prio = ['', '🔴 Hoch', '🟡 Mittel', '🟢 Niedrig'][v.prioritaet] || '';
        return `- #${v.id} ${prio} **${v.titel}** [${v.status}]${dl}${wv} | ${v.offene_delegationen} offene Delegationen`;
      }).join('\n')
    : '\n## Vorgänge\nKeine offenen Vorgänge.';

  const wvCtx = wiedervorlagen.length
    ? '\n## Wiedervorlage heute\n' + wiedervorlagen.map(v =>
        `- #${v.id} **${v.titel}** (fällig seit: ${new Date(v.wiedervorlage_am).toLocaleDateString('de-DE')})`
      ).join('\n')
    : '';

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

  const todosCtx = offeneTodos.length
    ? '\n## Offene Todos\n' + offeneTodos.map(t => {
        const q = t.wichtig && t.dringend ? 'Sofort' : t.wichtig ? 'Planen' : t.dringend ? 'Delegieren' : 'Eliminieren';
        const dl = t.faellig_am ? ` | fällig: ${new Date(t.faellig_am).toLocaleDateString('de-DE')}` : '';
        return `- #${t.id} [${q}] **${t.titel}** (${t.vorgang_titel})${dl}`;
      }).join('\n')
    : '';

  const kalenderCtx = kalender.length
    ? '\n## Kalender\n' + kalender.map(k => `- #${k.id} ${k.label}`).join('\n')
    : '';

  return `Du bist der persönliche KI-Assistent von ${process.env.OWNER_NAME || "der Schulleitung"}. Heute ist ${now}.

Du arbeitest vorgangszentriert: Alle Informationen werden Vorgängen zugeordnet. 
Vorgänge haben Namen wie "Vera 3 2026", "Brandschutzbegehung 2026", "Dienstliche Beurteilung Müller".

## Delegations-Personen
- [PERSON_1] (Sekretariat)
- [PERSON_2] (eFöB)
- [OWNER] (selbst)
${vorgangCtx}
${wvCtx}
${delegCtx}
${termineCtx}
${todosCtx}
${kalenderCtx}
${emailCtx}

## Deine Fähigkeiten
Du kannst Aktionen auslösen indem du JSON-Blöcke in deine Antwort einfügst. **Mehrere Blöcke sind erlaubt** – alle werden ausgeführt.

Vorgang anlegen:
\`\`\`json
{"action":"vorgang_anlegen","titel":"...","typ":"personal|behoerde|veranstaltung|planung|sonstiges","prioritaet":1,"deadline":"2026-06-01","beschreibung":"..."}
\`\`\`

Vorgang abschließen / Status ändern:
\`\`\`json
{"action":"vorgang_aktualisieren","vorgang_id":5,"status":"abgeschlossen"}
\`\`\`
Erlaubte Felder: titel, typ, status (offen|in_bearbeitung|wartet|abgeschlossen), prioritaet, deadline, wiedervorlage_am, beschreibung. null löscht ein Feld.

E-Mail einem Vorgang zuordnen:
\`\`\`json
{"action":"email_zuordnen","email_id":123,"vorgang_id":5}
\`\`\`

E-Mail als erledigt markieren:
\`\`\`json
{"action":"email_erledigen","email_id":123}
\`\`\`

E-Mail beantworten (Text vollständig ausformulieren):
\`\`\`json
{"action":"email_antworten","email_id":123,"text":"...","vorgang_id":5}
\`\`\`

Delegation anlegen:
\`\`\`json
{"action":"delegation_anlegen","vorgang_id":5,"an_name":"[PERSON_1]","an_rolle":"sekretariat","aufgabe":"...","deadline":"2026-05-15"}
\`\`\`

Delegation als erledigt markieren:
\`\`\`json
{"action":"delegation_erledigen","delegation_id":7}
\`\`\`

Delegation aktualisieren:
\`\`\`json
{"action":"delegation_aktualisieren","delegation_id":7,"deadline":"2026-06-01","notiz":"...","aufgabe":"..."}
\`\`\`

Notiz zu Vorgang:
\`\`\`json
{"action":"notiz_anlegen","vorgang_id":5,"titel":"...","inhalt":"..."}
\`\`\`

Todo anlegen:
\`\`\`json
{"action":"todo_anlegen","vorgang_id":5,"titel":"...","beschreibung":"...","faellig_am":"2026-05-15","wichtig":true,"dringend":false}
\`\`\`
wichtig/dringend steuern die Eisenhower-Matrix (wichtig=true → terminieren, wichtig+dringend=true → sofort). faellig_am ist optional.

Todo aktualisieren (Datum verschieben, Felder ändern):
\`\`\`json
{"action":"todo_aktualisieren","todo_id":3,"faellig_am":"2026-05-16"}
\`\`\`
Erlaubte Felder: titel, beschreibung, faellig_am, wichtig, dringend. Nur geänderte Felder. faellig_am null entfernt das Datum.

Todo als erledigt markieren:
\`\`\`json
{"action":"todo_erledigen","todo_id":3}
\`\`\`

Todo löschen:
\`\`\`json
{"action":"todo_loeschen","todo_id":3}
\`\`\`

Termin anlegen (Kalender-IDs aus dem Kontext oben):
\`\`\`json
{"action":"event_anlegen","kalender_id":1,"titel":"...","start":"2026-05-15T10:00","ende":"2026-05-15T11:00","ort":"...","beschreibung":"...","vorgang_id":5}
\`\`\`
ende und ort sind optional. vorgang_id optional.

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
    max_tokens: 2500,
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

  const actions = extractActions(assistantText);
  const actionResults = [];
  for (const a of actions) {
    actionResults.push(await executeAction(a));
  }

  return {
    text: assistantText,
    model,
    tokens: { in: response.usage.input_tokens, out: response.usage.output_tokens },
    actions,
    actionResults,
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
6. Schreibe eine Zusammenfassung (1–2 Sätze): Was sind die konkreten Aufgaben oder wichtigsten Infos für den Schulleiter? Bei "ignorieren" schreibe einen leeren String.

Bestehende Vorgänge:
${vorgaenge.map(v => `- #${v.id}: ${v.titel} [${v.typ}]`).join('\n') || 'Keine'}

E-Mail:
Von: ${email.from_name || email.from_email}
Betreff: ${email.subject}
Datum: ${email.date ? new Date(email.date).toLocaleString('de-DE') : '?'}
Inhalt: ${(email.body_text || '').slice(0, 800)}

Antworte NUR mit JSON:
{"einordnung":"vorgang_zuordnen"|"vorgang_anlegen"|"ignorieren","vorgang_id":null,"vorgang_titel":"...","begruendung":"...","prioritaet":1|2|3,"schlagworte":["Wort1","Wort2"],"ki_prioritaet":"dringend"|"normal"|"info","zusammenfassung":"..."}`;

  const response = await client.messages.create({
    model: MODEL_FAST,
    max_tokens: 600,
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
  // Liste der Bild-Blocks für den Vision-Call (eines pro PDF-Seite)
  let pages = [{ media_type: mediaType, data: imageBase64 }];

  // PDF → PNG konvertieren (alle Seiten)
  if (mediaType === 'application/pdf') {
    try {
      const { spawnSync } = await import('child_process');
      const { writeFileSync: wfs, readFileSync: rfs, unlinkSync, readdirSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join, dirname, basename } = await import('path');

      const tmpPdf = join(tmpdir(), `boox-${Date.now()}.pdf`);
      const tmpBase = join(tmpdir(), `boox-${Date.now()}`);

      wfs(tmpPdf, Buffer.from(imageBase64, 'base64'));

      // Alle Seiten als PNG exportieren – längere Kante auf 1800 px
      // (Claude Vision-Limit bei Multi-Image-Requests: 2000 px je Kante)
      spawnSync('pdftoppm', ['-scale-to', '1800', '-png', tmpPdf, tmpBase]);

      const tmpDir = dirname(tmpBase);
      const tmpPrefix = basename(tmpBase);
      const allFiles = readdirSync(tmpDir)
        .filter(fn => fn.startsWith(tmpPrefix) && fn.endsWith('.png'))
        .sort((a, b) => {
          // Numerisch sortieren: boox-…-1.png, …-2.png, …-10.png
          const na = parseInt(a.match(/-(\d+)\.png$/)?.[1] || '0', 10);
          const nb = parseInt(b.match(/-(\d+)\.png$/)?.[1] || '0', 10);
          return na - nb;
        });

      pages = allFiles.map(fn => {
        const full = join(tmpDir, fn);
        const data = rfs(full).toString('base64');
        try { unlinkSync(full); } catch (e) {}
        return { media_type: 'image/png', data };
      });

      try { unlinkSync(tmpPdf); } catch (e) {}

      if (pages.length === 0) throw new Error('PDF-Konvertierung lieferte keine Seiten');
    } catch (e) {
      console.error('[notizAnalysieren] PDF-Konvertierung:', e.message);
      throw e;
    }
  }

  const vorgaenge = await query(
    'SELECT id, titel FROM vorgaenge WHERE status != ? ORDER BY updated_at DESC LIMIT 20',
    ['abgeschlossen']
  );

  const seitenHinweis = pages.length > 1
    ? `Die Notiz besteht aus ${pages.length} Seiten (in Reihenfolge unten angehängt). Transkribiere alle Seiten in der Reihenfolge und extrahiere Aufgaben/Delegationen/Termine seitenübergreifend.`
    : '';

  const content = [
    ...pages.map(p => ({ type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.data } })),
    { type: 'text', text: `Du analysierst eine handgeschriebene Notiz des Schulleiters.
${seitenHinweis}

Bestehende Vorgänge:
${vorgaenge.map(v => `- #${v.id}: ${v.titel}`).join('\n') || 'Keine'}

Bitte:
1. Transkribiere den handgeschriebenen Text vollständig (bei mehreren Seiten alle, mit Seitenmarkern "--- Seite N ---")
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
}` },
  ];

  const response = await client.messages.create({
    model: MODEL_SMART,
    max_tokens: 4000,
    messages: [{ role: 'user', content }],
  });

  try {
    const text = response.content[0].text.trim().replace(/```json|```/g, '');
    const parsed = JSON.parse(text);
    parsed.seiten = pages.length;
    return parsed;
  } catch {
    return { transkription: response.content[0].text, seiten: pages.length, fehler: 'JSON-Parse fehlgeschlagen' };
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

Sei prägnant. Keine langen Erklärungen.

Verlinke Vorgänge als [Titel](vorgang:ID) und E-Mails als [Betreff](email:ID), damit der Nutzer direkt dorthin springen kann. Die IDs stehen im Kontext bei jedem #ID-Eintrag.`,
    }],
  });

  const text = response.content[0].text;

  await query(
    'INSERT INTO chat_messages (role, content, model, tokens_in, tokens_out) VALUES (?,?,?,?,?)',
    ['assistant', text, MODEL_FAST,
     response.usage?.input_tokens || 0, response.usage?.output_tokens || 0]
  );

  return text;
}

// ── Aktionen ausführen ────────────────────────────────────────────────────────

function extractActions(text) {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  return matches
    .map(m => { try { return JSON.parse(m[1].trim()); } catch { return null; } })
    .filter(a => a?.action);
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
      const email = await queryOne(
        'SELECT e.*, a.host, a.port, a.username, a.password, a.tls FROM emails e JOIN email_accounts a ON a.id = e.account_id WHERE e.id = ?',
        [action.email_id]
      );
      if (email) {
        // In IMAP-Vorgang-Ordner verschieben
        const vorgang = await queryOne('SELECT id, titel, imap_folder FROM vorgaenge WHERE id = ?', [action.vorgang_id]);
        if (vorgang) {
          let folderPath = vorgang.imap_folder;
          if (!folderPath) {
            folderPath = vorgangFolderPath(vorgang.titel);
            await query('UPDATE vorgaenge SET imap_folder = ? WHERE id = ?', [folderPath, vorgang.id]);
          }
          try {
            const newUid = await moveToVorgangFolder(email, email.imap_mailbox || 'INBOX', email.uid, folderPath);
            if (newUid) {
              await query('UPDATE emails SET uid = ?, imap_mailbox = ? WHERE id = ?', [newUid, folderPath, email.id]);
            }
          } catch (e) {
            console.warn('[IMAP] Zuordnungs-Verschiebung fehlgeschlagen:', e.message);
          }
        }
        // Chronologie-Eintrag
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

    case 'todo_anlegen': {
      const wichtig = action.wichtig !== false;
      const dringend = !!action.dringend;
      let eventUid = null;
      let eventCalId = null;

      if (action.faellig_am) {
        const setting = await queryOne("SELECT value FROM settings WHERE `key` = 'todo_calendar_id'");
        const calId = setting?.value ? parseInt(setting.value) : null;
        if (calId) {
          const quadrant = wichtig && dringend ? 'Sofort erledigen'
            : wichtig ? 'Terminieren'
            : dringend ? 'Delegieren' : 'Eliminieren';
          eventUid = randomUUID();
          await createCalDavEvent(calId, {
            uid: eventUid,
            title: `☑ ${action.titel}`,
            start: action.faellig_am,
            description: action.beschreibung ? `${action.beschreibung}\n[${quadrant}]` : `[${quadrant}]`,
          });
          eventCalId = calId;
        }
      }

      const result = await query(
        'INSERT INTO todos (vorgang_id, titel, beschreibung, faellig_am, wichtig, dringend, event_uid, calendar_id) VALUES (?,?,?,?,?,?,?,?)',
        [action.vorgang_id, action.titel, action.beschreibung || null, action.faellig_am || null,
         wichtig ? 1 : 0, dringend ? 1 : 0, eventUid, eventCalId]
      );
      return { done: 'todo_angelegt', id: result.insertId };
    }

    case 'todo_aktualisieren': {
      const todo = await queryOne('SELECT * FROM todos WHERE id = ?', [action.todo_id]);
      if (!todo) return { error: 'todo_nicht_gefunden', id: action.todo_id };

      const allowed = ['titel', 'beschreibung', 'faellig_am', 'wichtig', 'dringend'];
      const updates = [], params = [];
      for (const key of allowed) {
        if (key in action) {
          updates.push(`${key} = ?`);
          if (key === 'wichtig' || key === 'dringend') params.push(action[key] ? 1 : 0);
          else params.push(action[key] ?? null);
        }
      }
      if (!updates.length) return { done: 'todo_unveraendert' };
      params.push(action.todo_id);
      await query(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`, params);

      const newFaellig = 'faellig_am' in action ? action.faellig_am : todo.faellig_am;
      const newTitel = 'titel' in action ? action.titel : todo.titel;
      const newWichtig = 'wichtig' in action ? !!action.wichtig : !!todo.wichtig;
      const newDringend = 'dringend' in action ? !!action.dringend : !!todo.dringend;

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
          await query('UPDATE todos SET event_uid = ? WHERE id = ?', [newUid, action.todo_id]);
        } else {
          await query('UPDATE todos SET event_uid = NULL, calendar_id = NULL WHERE id = ?', [action.todo_id]);
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
          await query('UPDATE todos SET event_uid = ?, calendar_id = ? WHERE id = ?', [uid, calId, action.todo_id]);
        }
      }

      return { done: 'todo_aktualisiert', id: action.todo_id };
    }

    case 'vorgang_aktualisieren': {
      const allowed = ['titel', 'typ', 'status', 'prioritaet', 'deadline', 'wiedervorlage_am', 'beschreibung'];
      const updates = [], params = [];
      for (const key of allowed) {
        if (key in action) { updates.push(`${key} = ?`); params.push(action[key] ?? null); }
      }
      if (!updates.length) return { done: 'vorgang_unveraendert' };
      params.push(action.vorgang_id);
      await query(`UPDATE vorgaenge SET ${updates.join(', ')} WHERE id = ?`, params);
      return { done: 'vorgang_aktualisiert', vorgang_id: action.vorgang_id, felder: Object.keys(action).filter(k => allowed.includes(k)) };
    }

    case 'todo_erledigen': {
      const todo = await queryOne('SELECT * FROM todos WHERE id = ?', [action.todo_id]);
      if (!todo) return { error: 'todo_nicht_gefunden', id: action.todo_id };
      await query('UPDATE todos SET erledigt = 1, erledigt_am = NOW() WHERE id = ?', [action.todo_id]);
      if (todo.event_uid && todo.calendar_id) {
        await deleteCalDavEvent(todo.calendar_id, todo.event_uid).catch(() => {});
      }
      return { done: 'todo_erledigt', id: action.todo_id, titel: todo.titel };
    }

    case 'todo_loeschen': {
      const todo = await queryOne('SELECT * FROM todos WHERE id = ?', [action.todo_id]);
      if (!todo) return { error: 'todo_nicht_gefunden', id: action.todo_id };
      if (todo.event_uid && todo.calendar_id) {
        await deleteCalDavEvent(todo.calendar_id, todo.event_uid).catch(() => {});
      }
      await query('DELETE FROM todos WHERE id = ?', [action.todo_id]);
      return { done: 'todo_geloescht', id: action.todo_id, titel: todo.titel };
    }

    case 'delegation_erledigen': {
      await query("UPDATE delegationen SET status = 'erledigt' WHERE id = ?", [action.delegation_id]);
      return { done: 'delegation_erledigt', id: action.delegation_id };
    }

    case 'delegation_aktualisieren': {
      const allowed = ['deadline', 'notiz', 'aufgabe'];
      const updates = [], params = [];
      for (const key of allowed) {
        if (key in action) { updates.push(`${key} = ?`); params.push(action[key] ?? null); }
      }
      if (!updates.length) return { done: 'delegation_unveraendert' };
      params.push(action.delegation_id);
      await query(`UPDATE delegationen SET ${updates.join(', ')} WHERE id = ?`, params);
      return { done: 'delegation_aktualisiert', id: action.delegation_id };
    }

    case 'email_erledigen': {
      const email = await queryOne(
        'SELECT e.*, a.host, a.port, a.username, a.password, a.tls FROM emails e JOIN email_accounts a ON a.id = e.account_id WHERE e.id = ?',
        [action.email_id]
      );
      if (!email) return { error: 'email_nicht_gefunden', id: action.email_id };
      if (email.vorgang_id) {
        await query('UPDATE emails SET erledigt = 1, unread = 0 WHERE id = ?', [action.email_id]);
      } else {
        await query('UPDATE emails SET erledigt = 1, unread = 0, imap_mailbox = ? WHERE id = ?', ['Erledigt', action.email_id]);
        await moveToErledigt(email, email.uid, email.imap_mailbox || 'INBOX').catch(() => {});
      }
      return { done: 'email_erledigt', id: action.email_id };
    }

    case 'email_antworten': {
      const email = await queryOne('SELECT * FROM emails WHERE id = ?', [action.email_id]);
      if (!email) return { error: 'email_nicht_gefunden', id: action.email_id };
      await sendReply({
        accountId: email.account_id,
        toEmail: email.from_email,
        toName: email.from_name,
        subject: email.subject,
        body: action.text,
        inReplyTo: email.message_id,
        references: email.message_id,
      });
      if (action.vorgang_id) {
        await query(
          'INSERT INTO vorgang_eintraege (vorgang_id, typ, titel, inhalt) VALUES (?,?,?,?)',
          [action.vorgang_id, 'email', `Antwort: ${email.subject}`, action.text]
        );
      }
      return { done: 'email_beantwortet', id: action.email_id };
    }

    case 'event_anlegen': {
      const calId = action.kalender_id || (await queryOne('SELECT id FROM calendars WHERE active = 1 ORDER BY id ASC LIMIT 1'))?.id;
      if (!calId) return { error: 'kein_kalender' };
      const uid = randomUUID();
      await createCalDavEvent(calId, {
        uid,
        title: action.titel,
        start: action.start,
        end: action.ende || null,
        description: action.beschreibung || null,
      });
      await query(
        'INSERT INTO events (vorgang_id, calendar_id, uid, title, start_time, end_time, location, description) VALUES (?,?,?,?,?,?,?,?)',
        [action.vorgang_id || null, calId, uid, action.titel, action.start, action.ende || null, action.ort || null, action.beschreibung || null]
      );
      return { done: 'event_angelegt', uid, titel: action.titel };
    }

    default:
      return { done: 'unbekannte_aktion', action: action.action };
  }
}

// ── Natürlichsprachliche Suche ────────────────────────────────────────────────

export async function naturalSearchQuery(q) {
  const today = new Date().toISOString().split('T')[0];

  const prompt = `Du bist ein Datenbankassistent für "Conspectus", eine App für Schulleiter.
Übersetze die Suchanfrage in strukturierte JSON-Filter. Heute: ${today}.

Verfügbare Filter:

vorgaenge:
  status: string[] aus ["offen","in_bearbeitung","wartet","abgeschlossen"] (Standard: alles außer abgeschlossen)
  prioritaet: number[] aus [1,2,3] (1=hoch, 2=mittel, 3=niedrig)
  deadline_vor: "YYYY-MM-DD"
  deadline_nach: "YYYY-MM-DD"
  schlagwort: string (Freitext in Titel/Beschreibung)
  wiedervorlage_faellig: true
  hat_offene_delegationen: true
  keine_aktivitaet_seit_tagen: number

emails:
  erledigt: 0 oder 1
  ki_prioritaet: "hoch" | "mittel" | "niedrig"
  schlagwort: string (in Betreff/Body)
  von_name: string (Absender enthält)
  datum_vor: "YYYY-MM-DD"
  datum_nach: "YYYY-MM-DD"

delegationen:
  status: "offen" | "erledigt"
  ueberfaellig: true
  an_name: string (Empfänger enthält)
  deadline_vor: "YYYY-MM-DD"

todos:
  erledigt: 0 oder 1
  faellig_vor: "YYYY-MM-DD"
  faellig_nach: "YYYY-MM-DD"
  wichtig: 0 oder 1
  dringend: 0 oder 1

Gib NUR valides JSON zurück, kein Markdown:
{"tabellen":["vorgaenge"],"vorgaenge":{},"emails":{},"delegationen":{},"todos":{},"erklaerung":"kurze deutsche Beschreibung was gesucht wird"}

Suchanfrage: "${q.replace(/"/g, '\\"')}"`;

  const response = await client.messages.create({
    model: MODEL_FAST,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const text = response.content[0].text.trim().replace(/^```json|^```|```$/g, '').trim();
    return JSON.parse(text);
  } catch {
    return null;
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
