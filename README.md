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
  imap.js         – IMAP-Sync (mehrere Konten)
  caldav.js       – CalDAV-Sync (TZID-aware, Europe/Berlin)
  nextcloud.js    – WebDAV, Boox-Sync, URL-Encoding für Umlaute
  smtp.js         – E-Mail-Antworten senden
  pushover.js     – Push-Benachrichtigungen
frontend/
  index.html      – Komplettes Frontend (Single File)
scripts/
  setup-v2.sh     – Erstinstallation
  setup-sudoers.sh – Sudo-Rechte für Service-Neustart
```

---

## Features

**Dashboard**
- Morgen-Briefing (KI-generiert, täglich per Pushover)
- Kalender: Heute / Morgen / Diese Woche / 4-Wochen-Vorschau
- E-Mail-Eingang mit Toggle Alle / Unzugeordnet
- Offene Delegationen

**Vorgangsverwaltung**
- Vollständige Chronologie pro Vorgang (E-Mails, Notizen, Delegationen)
- Prioritäten (Hoch / Mittel / Niedrig), Deadlines, Typen
- Nextcloud-Ordner wird automatisch angelegt
- KI-Zusammenfassung und Nächste-Schritte auf Knopfdruck

**E-Mail**
- Body per IMAP nachladen (mit Spinner-Feedback)
- KI-Einordnung: Vorgang vorschlagen oder neu anlegen
- Antworten direkt aus der App (SMTP), KI-Entwurf auf Knopfdruck
- Archivieren

**Boox-Integration**
- PDFs werden automatisch stündlich aus Nextcloud geholt
- Claude transkribiert Handschrift, extrahiert Termine/Aufgaben/Delegationen
- Vorgang-Zuordnung mit Detailansicht im Dashboard
- Verarbeitete Dateien werden in Unterordner verschoben

**Kalender**
- CalDAV-Discovery: alle Kalender aus Nextcloud mit einem Klick einbinden
- Korrekte Zeitzone (TZID-Parsing für Europe/Berlin und W. Europe Standard Time)

**Pushover-Benachrichtigungen**
- Morgen-Briefing
- Überfällige Delegationen
- Termin-Erinnerungen 30 Min. vorher
- Nach jeder verarbeiteten Boox-Notiz

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

POST /vorgaenge                  – Vorgang anlegen
GET  /vorgaenge/:id              – Vorgang mit Chronologie

GET  /emails                     – E-Mails (neueste)
GET  /emails/unzugeordnet        – Nicht zugeordnete E-Mails
POST /emails/:id/body-v2         – Body per IMAP nachladen
POST /emails/:id/einordnen       – KI-Einordnung
POST /emails/:id/antworten       – E-Mail beantworten (SMTP)
POST /emails/:id/ki-entwurf      – KI-Antwort-Entwurf

GET  /events?days=28             – Kalendertermine
POST /sync                       – E-Mail-Sync manuell
POST /sync/calendar              – Kalender-Sync manuell

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
| Alle 5 Min. | E-Mail-Sync + KI-Einordnung |
| 6:30 Uhr | Morgen-Briefing + Pushover |
| 8:00 Uhr | Überfällige Delegationen per Pushover |
| Alle 15 Min. | Termin-Erinnerungen (30 Min. vorher) |
| Stündlich | Boox-Notizen prüfen |

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

## Kontext für neue Claude-Sessions

Am Anfang einer neuen Konversation genügt:

> „Ich arbeite an Conspectus, einem KI-Assistenten für Schulleitung.  
> Repo: https://github.com/rhigma/conspectus  
> Stack: Node.js, MariaDB, Nextcloud (CalDAV/WebDAV), Boox-Tablet, Pushover, Claude API.  
> Bitte lies die relevanten Dateien aus dem Repo bevor du Änderungen vorschlägst."

---

## Bekannte Besonderheiten

- **CalDAV-Zeitzone:** Nextcloud sendet `DTSTART;TZID=Europe/Berlin:...` – ohne TZID-Parsing entsteht ein +2h-Versatz. Gelöst in `caldav.js` mit `getTzid()`.
- **Nextcloud URL-Encoding:** Umlaute in Pfaden müssen per `encodeURIComponent()` pro Segment enkodiert werden.
- **systemd NoNewPrivileges:** verhindert `sudo` im Service → journalctl-Zugriff über Gruppenmitgliedschaft (`systemd-journal`), Restart über setuid-Wrapper `/usr/local/bin/ki-restart`.
- **Boox PDF→PNG:** `pdftoppm` erzeugt `-1.png` (ohne führende Nullen) → Datei per `readdirSync` finden.
- **MariaDB INSERT:** `mysql2` gibt bei `INSERT` kein Array zurück → `result.insertId` direkt (nicht `[result]`).
- **multer + express.json:** Chat-Endpunkt prüft `Content-Type` und wählt Middleware dynamisch.

---

*Conspectus – lateinisch für Überblick*
