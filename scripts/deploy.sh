#!/bin/bash
# deploy.sh – Sicheres Redeploy mit automatischem Rollback
# Aufruf: ./scripts/deploy.sh [git-branch]
set -euo pipefail

APP_DIR="/opt/ki-assistent"
BACKUP_DIR="/opt/ki-assistent-backup"
BRANCH="${1:-main}"
SERVICE="ki-assistent"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "FEHLER: $*" >&2; exit 1; }

log "=== Redeploy startet (Branch: $BRANCH) ==="

# 1. Backup des aktuellen Stands
log "Backup erstellen..."
rm -rf "$BACKUP_DIR"
cp -r "$APP_DIR" "$BACKUP_DIR"
# Datenbank NICHT überschreiben beim Rollback
cp "$APP_DIR/data/assistant.db" "/tmp/assistant.db.bak" 2>/dev/null || true

# 2. Neuen Code holen
log "Code aktualisieren..."
cd "$APP_DIR"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

# 3. Abhängigkeiten installieren (nur wenn package.json geändert)
if git diff HEAD@{1} --name-only | grep -q package.json; then
  log "Neue Abhängigkeiten installieren..."
  npm install --omit=dev
fi

# 4. Syntax-Check
log "Syntax prüfen..."
node --check src/server.js || {
  log "Syntax-Fehler! Rollback..."
  cp -r "$BACKUP_DIR/src" "$APP_DIR/src"
  die "Syntax-Check fehlgeschlagen, alten Code wiederhergestellt."
}

# 5. Service neustarten
log "Service neustarten..."
systemctl restart "$SERVICE"

# 6. Health-Check (10 Versuche)
log "Health-Check..."
for i in $(seq 1 10); do
  sleep 2
  if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1; then
    log "✓ Health-Check OK nach ${i}x2s"
    break
  fi
  if [ "$i" -eq 10 ]; then
    log "Health-Check fehlgeschlagen! Rollback..."
    cp -r "$BACKUP_DIR/src" "$APP_DIR/src"
    cp -r "$BACKUP_DIR/node_modules" "$APP_DIR/node_modules" 2>/dev/null || true
    systemctl restart "$SERVICE"
    die "Deploy fehlgeschlagen, Rollback abgeschlossen."
  fi
done

log "=== Deploy erfolgreich! ==="
systemctl status "$SERVICE" --no-pager -l | tail -5
