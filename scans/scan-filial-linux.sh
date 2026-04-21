#!/usr/bin/env bash
# Escaneo SOLO LECTURA de una filial Linux farmacia.
# Uso: bash scan-filial-linux.sh <IP> > farmacia-$(date +%F)/filial-<N>.txt

set -uo pipefail

IP="${1:?Falta IP — uso: $0 172.25.3.X}"
USER_SSH="${USER_SSH:-franco}"

echo "##############################################"
echo "# Scan filial linux $IP  $(date)"
echo "##############################################"

ssh "${USER_SSH}@${IP}" "bash -s" <<'REMOTE'
set -u

echo "=== HOSTNAME / OS ==="
hostname
cat /etc/os-release 2>/dev/null | grep -E "^NAME|^VERSION" || uname -a

echo
echo "=== Prereq binarios ==="
java -version 2>&1 | head -2
jq --version 2>&1 || echo "jq: MISSING"
curl --version 2>&1 | head -1
which flock || echo "flock: MISSING"

echo
echo "=== PostgreSQL cluster activo ==="
sudo -nu postgres psql -c "SHOW port;" 2>&1 | tail -3
sudo -nu postgres psql -c "SELECT datname FROM pg_database WHERE datname IN ('general','postgres') ORDER BY datname;" 2>&1 | tail -6

echo
echo "=== GRANT pg_subscription — franco ==="
sudo -nu postgres psql -c "SELECT has_table_privilege('franco','pg_catalog.pg_subscription','SELECT') AS franco_can_read_subs;" 2>&1 | tail -3

echo
echo "=== Systemd units FRC ==="
systemctl list-unit-files --state=enabled 2>&1 | grep -i frc
echo "--- frc-filial.service status ---"
systemctl status frc-filial.service --no-pager 2>&1 | head -10

echo
echo "=== Paths legacy vs CI/CD ==="
echo "--- /home/franco/FRC/ ---"
ls -la /home/franco/FRC/ 2>/dev/null | head -8
echo "--- /opt/frc-filial/ ---"
ls -la /opt/frc-filial/ 2>/dev/null | head -15
echo "--- releases ---"
ls -la /opt/frc-filial/releases/ 2>/dev/null | head -10
echo "--- symlink current ---"
readlink /opt/frc-filial/current 2>/dev/null || echo "no current symlink"

echo
echo "=== .env vs application.properties ==="
if [ -f /opt/frc-filial/.env ]; then
  echo "/opt/frc-filial/.env: EXISTS — $(wc -l < /opt/frc-filial/.env) lineas"
else
  echo "/opt/frc-filial/.env: MISSING"
fi
ls -la /home/franco/FRC/frc-server/application.properties 2>/dev/null \
  || echo "application.properties legacy: no encontrado"

echo
echo "=== Version actual ==="
cat /opt/frc-filial/.current-version 2>/dev/null || echo "no .current-version"
curl -fsS --max-time 5 localhost:8082/actuator/info 2>/dev/null | head -5 \
  || curl -fsS --max-time 5 localhost:8080/actuator/info 2>/dev/null | head -5 \
  || echo "no responde actuator/info en 8082 ni 8080"

echo
echo "=== Canal / filial-id / token ==="
cat /opt/frc-filial/.channel 2>/dev/null || echo "no .channel"
cat /opt/frc-filial/.filial-id 2>/dev/null || echo "no .filial-id"
[ -f /opt/frc-filial/.github-token ] && echo ".github-token: EXISTS ($(stat -c %s /opt/frc-filial/.github-token) bytes)" \
  || echo ".github-token: MISSING"

echo
echo "=== check-update.sh instalado ==="
ls -la /opt/frc-filial/check-update.sh 2>/dev/null || echo "check-update.sh: MISSING"

echo
echo "=== Cron — referencias a frc ==="
echo "--- crontab -l (user actual) ---"
crontab -l 2>/dev/null | grep -i frc || echo "crontab user: sin referencias frc"
echo "--- /etc/cron.d ---"
sudo -n ls -la /etc/cron.d/ 2>/dev/null | grep -i frc || echo "/etc/cron.d: sin frc"
echo "--- root crontab ---"
sudo -n crontab -l -u root 2>/dev/null | grep -i frc || echo "root crontab: sin frc o sudo falla"

echo
echo "=== Replication activa en general ==="
sudo -nu postgres psql -d general -c "SELECT pubname FROM pg_publication ORDER BY pubname;" 2>&1 | tail -10
sudo -nu postgres psql -d general -c "SELECT subname, subenabled FROM pg_subscription ORDER BY subname;" 2>&1 | tail -10
sudo -nu postgres psql -d general -c "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;" 2>&1 | tail -10

echo
echo "=== Logs update.log recientes ==="
tail -30 /opt/frc-filial/logs/update.log 2>/dev/null || echo "no update.log"

echo
echo "=== Puertos abiertos ==="
sudo -n ss -ltnp 2>/dev/null | grep -E ":808[0-9]|:5432|:5551" | head -10 \
  || ss -ltn 2>&1 | grep -E ":808[0-9]|:5432|:5551" | head -10

echo
echo "=== Done $(date) ==="
REMOTE
