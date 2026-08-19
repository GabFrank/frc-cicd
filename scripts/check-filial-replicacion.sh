#!/usr/bin/env bash
# =============================================================================
# check-filial-replicacion.sh — Readiness de replicación lógica de una FILIAL
# =============================================================================
# Verificación SOLO-LECTURA que corre ANTES de provisionar la DB de una filial
# nueva. Confirma que la filial puede (a) SUBSCRIBIR a la publicación del central
# (recibir maestro) y (b) PUBLICAR sus operativas al central (para eso necesita
# wal_level=logical). No cambia nada — solo reporta GO / NO-GO.
#
# Se conecta por SSH (soporta --via para ProxyJump si la filial solo es
# alcanzable por la malla headscale, p.ej. --via franco@172.25.1.200 y
# --target-host 100.64.0.4 / farmacia-nueva).
#
# Uso:
#   ./check-filial-replicacion.sh \
#       --target-host 192.168.0.156 --target-user franco --sudo-pass-env FILIAL_PW \
#       [--target-pg-port 5551] [--central-host central] [--central-pg-port 5551] \
#       [--via franco@172.25.1.200]
#
# El sudo password se toma de la variable de entorno nombrada en --sudo-pass-env
# (no se pasa por CLI). Ej: FILIAL_PW=franco ./check-filial-replicacion.sh ...
# =============================================================================
set -uo pipefail

TARGET_HOST=""; TARGET_USER="franco"; TARGET_PG_PORT="5551"
CENTRAL_HOST="central"; CENTRAL_PG_PORT="5551"
VIA=""; SUDO_PASS_ENV=""; PG_SUPERUSER="postgres"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-host) TARGET_HOST="$2"; shift 2;;
    --target-user) TARGET_USER="$2"; shift 2;;
    --target-pg-port) TARGET_PG_PORT="$2"; shift 2;;
    --central-host) CENTRAL_HOST="$2"; shift 2;;
    --central-pg-port) CENTRAL_PG_PORT="$2"; shift 2;;
    --via) VIA="$2"; shift 2;;
    --sudo-pass-env) SUDO_PASS_ENV="$2"; shift 2;;
    --pg-superuser) PG_SUPERUSER="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \?//'; exit 0;;
    *) echo "Arg desconocido: $1" >&2; exit 2;;
  esac
done

[[ -n "$TARGET_HOST" ]] || { echo "falta --target-host" >&2; exit 2; }
SUDO_PW=""; [[ -n "$SUDO_PASS_ENV" ]] && SUDO_PW="${!SUDO_PASS_ENV:-}"

SSH_OPTS=(-o ConnectTimeout=12 -o BatchMode=yes)
[[ -n "$VIA" ]] && SSH_OPTS+=(-J "$VIA")
SSH="ssh ${SSH_OPTS[*]} ${TARGET_USER}@${TARGET_HOST}"

green(){ echo -e "  \033[1;32m✓\033[0m $*"; }
red(){   echo -e "  \033[1;31m✗\033[0m $*"; FAILS=$((FAILS+1)); }
warn(){  echo -e "  \033[1;33m!\033[0m $*"; }
FAILS=0

echo "== Readiness replicación filial: ${TARGET_USER}@${TARGET_HOST} (via='${VIA:-directo}') =="

# Bloque remoto: exporta funciones y corre todos los checks en un solo SSH.
REMOTE=$(cat <<'RSCRIPT'
PW="$1"; PGP="$2"; SU="$3"; CH="$4"; CP="$5"
S(){ if [ -n "$PW" ]; then echo "$PW" | sudo -S "$@" 2>/dev/null; else sudo -n "$@" 2>/dev/null; fi; }
Q(){ S -u "$SU" psql -p "$PGP" -tAc "$1" 2>/dev/null; }

echo "@@HOST $(hostname) | $(. /etc/os-release 2>/dev/null; echo "$NAME $VERSION_ID")"
# 1. PG instalado + servicio
if command -v psql >/dev/null 2>&1; then echo "@@PSQL ok"; else echo "@@PSQL missing"; fi
echo "@@SVC $(S systemctl is-active postgresql 2>/dev/null || echo desconocido)"
echo "@@LISTEN $(S ss -tlnH 2>/dev/null | grep -oE ':(543[0-9]|55[0-9][0-9])' | tr -d ':' | sort -u | tr '\n' ' ')"
# 2. conexión postgres + version
V=$(Q "SELECT current_setting('server_version');"); echo "@@PGVER ${V:-none}"
# 3. parametros
for p in wal_level max_wal_senders max_replication_slots max_logical_replication_workers max_worker_processes; do
  echo "@@PARAM $p $(Q "SHOW $p;")"
done
# 4. roles REPLICATION
echo "@@REPLROLES $(Q "SELECT string_agg(rolname||'(login='||rolcanlogin||')',',') FROM pg_roles WHERE rolreplication;")"
# 5. DB general + subs/pubs existentes
echo "@@GENERAL $(Q "SELECT count(*) FROM pg_database WHERE datname='general';")"
echo "@@SUBS $(S -u "$SU" psql -p "$PGP" -d general -tAc "SELECT string_agg(subname,',') FROM pg_subscription;" 2>/dev/null)"
echo "@@PUBS $(S -u "$SU" psql -p "$PGP" -d general -tAc "SELECT string_agg(pubname,',') FROM pg_publication;" 2>/dev/null)"
# 6. alcance al central PG (para la CONNECTION del subscription)
if command -v nc >/dev/null 2>&1; then
  nc -z -w4 "$CH" "$CP" 2>/dev/null && echo "@@CENTRALPG reachable" || echo "@@CENTRALPG unreachable"
else echo "@@CENTRALPG nc-missing"; fi
RSCRIPT
)

OUT=$($SSH "bash -s -- '$SUDO_PW' '$TARGET_PG_PORT' '$PG_SUPERUSER' '$CENTRAL_HOST' '$CENTRAL_PG_PORT'" <<<"$REMOTE" 2>&1)
if [[ -z "$OUT" || "$OUT" != *"@@HOST"* ]]; then
  echo; red "No pude ejecutar checks (¿filial offline / SSH? salida: ${OUT:0:120})"; echo; echo "NO-GO"; exit 1
fi

get(){ echo "$OUT" | grep "^@@$1 " | head -1 | cut -d' ' -f2-; }

echo; echo "Host: $(get HOST)"
[[ "$(get PSQL)" == "ok" ]] && green "psql instalado" || red "psql NO instalado"
[[ "$(get SVC)" == "active" ]] && green "servicio postgresql active" || red "postgresql no active ($(get SVC))"
green "puertos PG: $(get LISTEN)"
PGVER=$(get PGVER); [[ "$PGVER" != "none" && -n "$PGVER" ]] && green "conecta como $PG_SUPERUSER, PG $PGVER" || red "no conecta como $PG_SUPERUSER (peer auth / socket)"

WAL=$(echo "$OUT" | grep '^@@PARAM wal_level ' | awk '{print $3}')
[[ "$WAL" == "logical" ]] && green "wal_level=logical (puede PUBLICAR al central)" || red "wal_level=$WAL — DEBE ser 'logical' (requiere editar postgresql.conf + RESTART)"
for p in max_wal_senders max_replication_slots max_logical_replication_workers; do
  v=$(echo "$OUT" | grep "^@@PARAM $p " | awk '{print $3}')
  if [[ -n "$v" && "$v" -ge 4 ]] 2>/dev/null; then green "$p=$v"; else warn "$p=$v (recomendado >=4-10)"; fi
done

RR=$(get REPLROLES); [[ -n "$RR" ]] && green "roles REPLICATION: $RR" || red "no hay rol con REPLICATION (necesario para pub filial->central)"
G=$(get GENERAL); [[ "$G" == "1" ]] && warn "DB 'general' YA existe (el provisioning la DROP/CREATE — se respalda antes)" || green "DB 'general' no existe aún (limpio para provisionar)"
[[ -n "$(get SUBS)" ]] && warn "subscriptions preexistentes: $(get SUBS) (revisar/limpiar antes de re-suscribir)" || green "sin subscriptions preexistentes"
[[ -n "$(get PUBS)" ]] && warn "publications preexistentes: $(get PUBS)" || green "sin publications preexistentes"
CPG=$(get CENTRALPG)
[[ "$CPG" == "reachable" ]] && green "alcanza central PG ($CENTRAL_HOST:$CENTRAL_PG_PORT) — la CONNECTION del subscription funcionará" || red "NO alcanza central PG ($CENTRAL_HOST:$CENTRAL_PG_PORT) — revisar headscale/pg_hba/firewall"

echo
if [[ $FAILS -eq 0 ]]; then echo -e "\033[1;32mGO\033[0m — filial lista para provisionar + replicar."; exit 0
else echo -e "\033[1;31mNO-GO\033[0m — $FAILS bloqueante(s). Resolver antes de copiar la DB."; exit 1; fi
