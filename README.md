# Conspectus

**Persönlicher KI-Assistent für Schulleitung**  
Ein selbst gehostetes System das Vorgänge, E-Mails, Kalender, Notizen und Delegationen bündelt – unterstützt durch Claude (Anthropic) als KI.

---

## Was ist Conspectus?

Der Name kommt vom Lateinischen: *conspectus* = Überblick, Gesamtschau.

Conspectus ist kein klassisches Schulverwaltungsprogramm, sondern ein persönlicher Assistent für den Schulalltag. Alles dreht sich um **Vorgänge** – nicht um einzelne E-Mails oder Termine, sondern um zusammenhängende Themen die verfolgt werden müssen.

Ein Vorgang bündelt:
- Schriftverkehr (E-Mails)
- Handgeschriebene Notizen (via Boox-Integration)
- Delegationen (wer macht was bis wann)
- Kalendertermine
- Dokumente (via Nextcloud)

---

## Stack

| Komponente | Technologie |
|---|---|
| Backend | Node.js, Express |
| Datenbank | MariaDB |
| Frontend | Single-Page-App (HTML/CSS/JS, kein Framework) |
| E-Mail | IMAP (mehrere Konten) + SMTP |
| Kalender | CalDAV (Nextcloud, korrekte Zeitzone Europe/Berlin) |
| Dateien | Nextcloud (WebDAV) |
| Notizen | Boox-Tablet → Nextcloud → PDF → Claude |
| KI | Claude API (Haiku für Alltag, Sonnet für Bilder) |
| Push | Pushover |
| Hosting | Eigener VPS (Debian), Nginx, systemd |

---

## Projektstruktur

```
src/
  server.js       – Express-API, alle Endpunkte
  db.js           – MariaDB-Schema und Query-Helpers
  ai.js           – Claude-Integration, Systemkontext, Aktionen
  imap.js         – IMAP-Sync (mehrere Konten, Two-Pass)
  caldav.js       – CalDAV-Sync (TZID-aware, Europe/Berlin)
  nextcloud.js    – WebDAV, Boox-Sync, URL-Encoding für Umlaute
  smtp.js         – E-Mail-Antworten senden
  pushover.js     – Push-Benachrichtigungen
frontend/
  index.html      – Komplettes Frontend (Single File)
scripts/
  deploy.sh            – Produktions-Deploy mit Rollback
  setup-v2.sh          – Erstinstallation
  setup-sudoers.sh     – Sudo-Rechte für Service-Neustart
  backfill-bodies.mjs  – Body für alte E-Mails nachladen
  backfill-ki-analyse.mjs – KI-Analyse für alte E-Mails nachholen
```

---

## Features

**Dashboard**
- Morgen-Briefing (KI-generiert, täglich per Pushover)
- Kalender: Heute / Morgen / Diese Woche / 4-Wochen-Vorschau
- E-Mail-Eingang mit Toggle Aktiv / Unzugeordnet / Erledigt
- Offene Delegationen

**Vorgangsverwaltung**
- Vollständige Chronologie pro Vorgang (E-Mails, Notizen, Delegationen)
- Prioritäten (Hoch / Mittel / Niedrig), Deadlines, Typen
- Nextcloud-Ordner wird automatisch angelegt
- KI-Zusammenfassung und Nächste-Schritte auf Knopfdruck

**E-Mail-Verwaltung**
- Eigener Tab mit der vollständigen E-Mail-Liste (bis zu 500 E-Mails)
- KI-Analyse beim Sync: Schlagworte und Priorität (dringend / normal / info)
- Schlagwort-Chips zur Filterung (client-side, aus KI-Analyse)
- Sortierung nach Priorität (dringend zuerst)
- Body per IMAP nachladen
- KI-Einordnung: Vorgang vorschlagen oder neu anlegen
- Antworten direkt aus der App (SMTP), KI-Entwurf auf Knopfdruck
- E-Mail als erledigt markieren (Archivierung in IMAP-Ordner „Erledigt")

**Boox-Integration**
- PDFs werden automatisch stündlich aus Nextcloud geholt
- Claude transkribiert Handschrift, extrahiert Termine/Aufgaben/Delegationen
- Vorgang-Zuordnung mit Detailansicht im Dashboard
- Verarbeitete Dateien werden in Unterordner verschoben

**Kalender**
- CalDAV-Discovery: alle Kalender aus Nextcloud mit einem Klick einbinden
- Korrekte Zeitzone (TZID-Parsing für Europe/Berlin und W. Europe Standard Time)

**Volltext-Suche**
- Globale Suche über Vorgänge, E-Mails und Delegationen
- Erreichbar über die Suchleiste oben rechts

**Pushover-Benachrichtigungen**
- Morgen-Briefing
- Überfällige Delegationen
- Termin-Erinnerungen 30 Min. vorher
- Nach jeder verarbeiteten Boox-Notiz

**Darstellung**
- Dark Mode (Toggle in der Topbar, persistent im localStorage)

**Einstellungen**
- E-Mail-Konten (IMAP), Kalender (CalDAV), Delegations-Personen
- System: Kosten, Sync-Intervall, Logs
- Update-Mechanismus: GitHub Pull oder Datei-Upload direkt im Browser

---

## Umgebungsvariablen (.env)

```env
# KI
ANTHROPIC_API_KEY=sk-ant-...
MODEL_FAST=claude-haiku-4-5-20251001
MODEL_SMART=claude-sonnet-4-6

# Server
PORT=3001
API_SECRET=<langer zufälliger String>
APP_URL=https://deine-domain.de
OWNER_NAME=Schulleitung

# Datenbank
DB_HOST=...
DB_PORT=3306
DB_NAME=...
DB_USER=...
DB_PASS=...

# Nextcloud
NC_URL=https://nextcloud.example.com
NC_USER=...
NC_PASS=...

# Pushover
PUSHOVER_TOKEN=...
PUSHOVER_USER=...

# Sync
SYNC_INTERVAL_MINUTES=5
BRIEFING_HOUR=6
BRIEFING_MINUTE=30
```

---

## API-Endpunkte (Auswahl)

Alle Requests benötigen: `X-Api-Key: <API_SECRET>`

```
GET  /health                     – Statuscheck (kein Auth nötig)
GET  /stats                      – Übersicht + Token-Kosten
GET  /search?q=                  – Volltext-Suche (Vorgänge, E-Mails, Delegationen)

POST /vorgaenge                  – Vorgang anlegen
GET  /vorgaenge/:id              – Vorgang mit Chronologie

GET  /emails                     – E-Mails (Filter: limit, erledigt, vorgang_id)
GET  /emails/themen              – Vorgänge mit E-Mail-Zählungen
GET  /emails/unzugeordnet        – Nicht zugeordnete E-Mails
POST /emails/:id/body-v2         – Body per IMAP nachladen
POST /emails/:id/einordnen       – KI-Einordnung
POST /emails/:id/erledigt        – Als erledigt markieren + IMAP-Archivierung
POST /emails/:id/antworten       – E-Mail beantworten (SMTP)
POST /emails/:id/ki-entwurf      – KI-Antwort-Entwurf

GET  /events?days=28             – Kalendertermine
POST /sync                       – E-Mail-Sync + KI-Analyse manuell
POST /sync/calendar              – Kalender-Sync manuell

GET  /personen                   – Delegations-Personen
POST /briefing                   – Morgen-Briefing erstellen
POST /chat                       – KI-Chat (JSON oder Multipart+Bilder)

POST /boox/sync                  – Boox-Notizen verarbeiten
GET  /boox/status                – Letzte verarbeitete Notizen

POST /accounts/calendar/discover – CalDAV-Kalender entdecken
POST /system/upload              – Datei-Update im Browser
POST /system/git-pull            – Update von GitHub
POST /system/restart             – Server neu starten
GET  /system/log                 – Letzter journalctl-Output

POST /push/test                  – Pushover-Test
```

---

## Automatische Jobs

| Zeit | Aufgabe |
|---|---|
| Alle 5 Min. | E-Mail-Sync + KI-Einordnung (Schlagworte + Priorität) |
| 6:30 Uhr | Morgen-Briefing + Pushover |
| 8:00 Uhr | Überfällige Delegationen per Pushover |
| Alle 15 Min. | Termin-Erinnerungen (30 Min. vorher) + CalDAV-Sync |
| Stündlich | Boox-Notizen prüfen |

---

## Backfill-Skripte

Einmalig auf dem VPS ausführen, um ältere Daten nachzuverarbeiten:

```bash
cd /opt/ki-assistent

# Body-Text für E-Mails nachladen, die während der Erst-Synchronisation
# nur die Hülle (ohne Body) gespeichert haben
node scripts/backfill-bodies.mjs

# KI-Analyse (Schlagworte + Priorität) für E-Mails nachholen,
# die noch kein erweitertes ki_einordnung-Format haben
node scripts/backfill-ki-analyse.mjs        # Standard: max. 500 E-Mails
node scripts/backfill-ki-analyse.mjs 100    # Optional: Anzahl begrenzen
```

---

## Update-Workflow

**Über den Browser:**
Einstellungen → ↑ System-Update → „↓ Von GitHub laden"

**Manuell:**
```bash
cd /opt/ki-assistent
git pull origin main
systemctl restart ki-assistent
```

---

## Bekannte Besonderheiten

- **CalDAV-Zeitzone:** Nextcloud sendet `DTSTART;TZID=Europe/Berlin:...` – ohne TZID-Parsing entsteht ein +2h-Versatz. Gelöst in `caldav.js` mit `getTzid()`.
- **Nextcloud URL-Encoding:** Umlaute in Pfaden müssen per `encodeURIComponent()` pro Segment enkodiert werden.
- **systemd NoNewPrivileges:** verhindert `sudo` im Service → journalctl-Zugriff über Gruppenmitgliedschaft (`systemd-journal`), Restart über setuid-Wrapper `/usr/local/bin/ki-restart`.
- **Boox PDF→PNG:** `pdftoppm` erzeugt `-1.png` (ohne führende Nullen) → Datei per `readdirSync` finden.
- **MariaDB INSERT:** `mysql2` gibt bei `INSERT` kein Array zurück → `result.insertId` direkt (nicht `[result]`).
- **multer + express.json:** Chat-Endpunkt prüft `Content-Type` und wählt Middleware dynamisch.
- **IMAP-Sync Two-Pass:** `ImapFlow` kann `client.download()` nicht innerhalb eines laufenden `client.fetch()`-Loops aufrufen (Verbindung belegt) → Pass 1 sammelt UIDs, Pass 2 lädt `{source:true}` einzeln nach.
- **git safe.directory:** Läuft der Service als anderer User als der Repo-Eigentümer, schlägt `git pull` mit „dubious ownership" fehl. Fix: `git -c safe.directory=/opt/ki-assistent -C /opt/ki-assistent pull origin main`.
- **Express-Routenreihenfolge:** `/emails/themen` muss vor `/emails/:id` registriert sein, sonst wird `themen` als `:id` interpretiert.

---

*Conspectus – lateinisch für Überblick*
