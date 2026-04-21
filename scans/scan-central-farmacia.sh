#!/usr/bin/env bash
# Escaneo SOLO LECTURA de central farmacia 172.25.1.200:8082 (instancia productiva).
# Uso: bash scan-central-farmacia.sh > farmacia-$(date +%F)/central.txt
#
# Asume SSH disponible como user `franco` (legacy actual del central productivo).
# Requiere password interactivo o sshpass preconfigurado.

set -uo pipefail

IP="${IP:-172.25.1.200}"
USER_SSH="${USER_SSH:-franco}"

echo "##############################################"
echo "# Scan central farmacia $IP  $(date)"
echo "##############################################"

ssh "${USER_SSH}@${IP}" "bash -s" <<'REMOTE'
set -u

echo "=== HOSTNAME / OS ==="
hostname
cat /etc/os-release 2>/dev/null | grep -E "^NAME|^VERSION" || uname -a

echo
echo "=== Users existentes ==="
id franco 2>/dev/null || echo "franco: MISSING"
id deploy 2>/dev/null || echo "deploy: MISSING"

echo
echo "=== Sudoers entries para deploy ==="
sudo -n test -r /etc/sudoers.d/deploy-frc 2>/dev/null \
  && sudo -n cat /etc/sudoers.d/deploy-frc 2>&1 \
  || echo "sudoers.d/deploy-frc: MISSING o sudo requiere password"

echo
echo "=== Systemd unit actual — frc-farmacia.service ==="
systemctl status frc-farmacia.service --no-pager 2>&1 | head -12
echo "--- unit file ---"
sudo -n cat /etc/systemd/system/frc-farmacia.service 2>/dev/null \
  || cat /etc/systemd/system/frc-farmacia.service 2>/dev/null \
  || echo "unit: MISSING"

echo
echo "=== Paths — legacy vs CI/CD pool ==="
echo "--- /home/franco/farma/FRC/frc-server/ ---"
ls -la /home/franco/farma/FRC/frc-server/ 2>/dev/null | head -8
echo "--- /opt/frc-backend-central/farmacia/ ---"
ls -la /opt/frc-backend-central/farmacia/ 2>/dev/null | head -8
echo "--- /opt/frc-backend-central/releases/ ---"
ls -la /opt/frc-backend-central/releases/ 2>/dev/null | head -10
echo "--- symlink current ---"
readlink /opt/frc-backend-central/farmacia/current 2>/dev/null || echo "no current symlink"

echo
echo "=== Version actual (3.0.9 esperado) ==="
cat /opt/frc-backend-central/farmacia/.current-version 2>/dev/null \
  || cat /home/franco/farma/FRC/frc-server/VERSION 2>/dev/null \
  || echo "no VERSION file"
echo "--- actuator/info ---"
curl -fsS --max-time 5 localhost:8082/actuator/info 2>/dev/null | head -5 \
  || echo "no responde /actuator/info"

echo
echo "=== Config del JAR — .env vs application.properties ==="
if [ -f /opt/frc-backend-central/farmacia/.env ]; then
  echo ".env: EXISTS — $(wc -l < /opt/frc-backend-central/farmacia/.env) lineas"
else
  echo ".env: MISSING"
fi
ls -la /home/franco/farma/FRC/frc-server/application.properties 2>/dev/null \
  || echo "application.properties: no encontrado en paths legacy"

echo
echo "=== Java ==="
java -version 2>&1 | head -2

echo
echo "=== PostgreSQL cluster 5551 ==="
sudo -nu postgres psql -p 5551 -c "SHOW port;" 2>&1 | tail -3
sudo -nu postgres psql -p 5551 -c "SELECT datname FROM pg_database WHERE datname IN ('bodega','farmacia','alpha','beta') ORDER BY datname;" 2>&1 | tail -10

echo
echo "=== GRANT pg_subscription — franco ==="
sudo -nu postgres psql -p 5551 -d farmacia -c \
  "SELECT has_table_privilege('franco','pg_catalog.pg_subscription','SELECT') AS franco_can_read_subs;" 2>&1 | tail -3

echo
echo "=== Replication — publicaciones/suscripciones existentes ==="
echo "--- pubs ---"
sudo -nu postgres psql -p 5551 -d farmacia -c \
  "SELECT pubname FROM pg_publication ORDER BY pubname;" 2>&1 | tail -20
echo "--- subs ---"
sudo -nu postgres psql -p 5551 -d farmacia -c \
  "SELECT subname, subenabled FROM pg_subscription ORDER BY subname;" 2>&1 | tail -20
echo "--- slots ---"
sudo -nu postgres psql -p 5551 -d farmacia -c \
  "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;" 2>&1 | tail -20

echo
echo "=== empresarial.sucursal — IPs hardcoded (riesgo DB clonada) ==="
sudo -nu postgres psql -p 5551 -d farmacia -c \
  "SELECT id, nombre, ip, puerto, activo FROM empresarial.sucursal ORDER BY id;" 2>&1 | head -40

echo
echo "=== Schedulers replicación en application.properties legacy ==="
sudo -n grep -E "replication\.(sync|refresh)\." \
  /home/franco/farma/FRC/frc-server/application.properties 2>/dev/null \
  || echo "no config legacy o sudo falla"

echo
echo "=== deploy.sh en pool ==="
ls -la /opt/frc-backend-central/*/deploy.sh 2>/dev/null || echo "no deploy.sh en instancias"
ls -la /opt/frc-backend-central/releases/*/deploy.sh 2>/dev/null || echo "no deploy.sh en releases"

echo
echo "=== Cronjobs referenciando paths legacy ==="
sudo -n grep -r "frc-server.jar\|/home/franco/farma" /etc/cron* /var/spool/cron 2>/dev/null \
  | head -10 || echo "cron: limpio o sudo requiere password"

echo
echo "=== Sync-health del dashboard ve este host ==="
curl -fsS --max-time 5 http://172.25.0.172:3000/api/data/central 2>/dev/null \
  | head -1000 | grep -oE "\"nombre\":\"[^\"]*Farmacia[^\"]*\"[^,]*" | head -5 \
  || echo "sin acceso a dashboard o no hay datos de Farmacia"

echo
echo "=== Puertos abiertos por procesos FRC ==="
sudo -n ss -ltnp 2>/dev/null | grep -E ":808[0-9]|:555[0-2]|:5432" | head -15 \
  || ss -ltn 2>&1 | grep -E ":808[0-9]|:555[0-2]|:5432" | head -15

echo
echo "=== Done $(date) ==="
REMOTE
