#!/usr/bin/env bash
# Backup diario del SQLite del dashboard.
# Instalar como cron del HOST (no del contenedor):
#   sudo cp deploy/backup.sh /usr/local/bin/frc-dash-backup.sh
#   sudo chmod +x /usr/local/bin/frc-dash-backup.sh
#   echo "15 3 * * * /usr/local/bin/frc-dash-backup.sh" | sudo tee /etc/cron.d/frc-dash-backup
#
# Asume volumen docker `dash-data` montado en el path estándar de Docker.
# Ajustar SRC si cambia la ubicación real del archivo.

set -euo pipefail

SRC="/var/lib/docker/volumes/frc-dashboard_dash-data/_data/dash.db"
DEST_DIR="/var/backups/frc-dashboard"
RETENTION_DAYS=7

mkdir -p "$DEST_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${DEST_DIR}/dash-${STAMP}.db"

if [ ! -f "$SRC" ]; then
    echo "[backup] src not found: $SRC" >&2
    exit 1
fi

# Usar `sqlite3 .backup` si está disponible; fallback a cp (ok por WAL).
if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$SRC" ".backup '${DEST}'"
else
    cp -a "$SRC" "$DEST"
fi

find "$DEST_DIR" -name 'dash-*.db' -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] ok -> $DEST"
