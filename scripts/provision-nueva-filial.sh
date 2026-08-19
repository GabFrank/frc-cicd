#!/usr/bin/env bash
# =============================================================================
# provision-nueva-filial.sh — Provisioning de DB para una FILIAL NUEVA
# =============================================================================
# Siembra la base `general` de una filial nueva con SOLO datos maestros
# (productos, precios, sucursales, personas, etc.), dejando las tablas
# OPERATIVAS por-sucursal VACÍAS (venta, venta_item, pdv_caja, inicio_sesion,
# movimiento_stock, cobro, factura_legal, ...). Una filial nueva no tiene
# historial operativo — ese lo genera localmente y se replica al central.
#
# Reemplaza al viejo `restauracion_filial_25.sql` (INSERTs por niveles vía
# dblink, hardcodeado a sucursal 25 e IPs ZeroTier, password en claro). Este
# usa pg_dump/pg_restore (resuelve orden de FKs y dependencias circulares solo)
# y toda conexión PG es LOCAL vía SSH en cada host (evita pg_hba entre hosts).
#
# NO configura replicación lógica — imprime los comandos al final (Fase aparte).
#
# Uso:
#   ./provision-nueva-filial.sh \
#       --source-host central --source-user franco --source-pg-port 5551 --source-db farmacia \
#       --target-host 192.168.0.156 --target-user franco --target-pg-port 5432 --target-db general \
#       --sucursal-id 30 \
#       [--from-publication central_filial5_pub]   # deriva la lista de exclusión VIVA
#       [--dry-run] [--yes]
#
# `--source-host central` = nombre MagicDNS headscale del central (recomendado,
# reemplaza a 172.25.1.200 / 159.203.86.103). El SSH y el pg_dump corren EN el
# central sobre localhost, así que da igual la IP overlay.
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SOURCE_HOST=""; SOURCE_USER="franco"; SOURCE_PG_PORT="5551"; SOURCE_DB=""
TARGET_HOST=""; TARGET_USER="franco"; TARGET_PG_PORT="5432"; TARGET_DB="general"
SUCURSAL_ID=""
FROM_PUBLICATION=""
DRY_RUN=0; ASSUME_YES=0
PG_SUPERUSER="postgres"          # user local con permiso DROP/CREATE DATABASE
DUMP_REMOTE="/tmp/filial-seed.dump"

# Schemas que existen en una filial `general` (subconjunto del central; el
# central tiene además fmc/scheduler que NO se copian).
FILIAL_SCHEMAS=(administrativo configuraciones empresarial equipos financiero \
                general operaciones personas productos vehiculos)

# Lista por DEFECTO de tablas OPERATIVAS por-sucursal a dejar VACÍAS.
# Fuente: publicación `central_filial25_pub` (las 27 tablas replicadas
# central<->filial). Si pasás --from-publication, se deriva la lista VIVA y
# esta queda solo de fallback.
DEFAULT_OPERATIONAL=(
  administrativo.marcacion
  configuraciones.inicio_sesion
  financiero.cambio_caja
  financiero.conteo
  financiero.conteo_moneda
  financiero.factura_legal
  financiero.factura_legal_item
  financiero.gasto
  financiero.gasto_detalle
  financiero.maletin
  financiero.movimiento_caja
  financiero.pdv_caja
  financiero.retiro
  financiero.retiro_detalle
  financiero.sencillo
  financiero.sencillo_detalle
  financiero.venta_credito
  financiero.venta_credito_cuota
  operaciones.cobro
  operaciones.cobro_detalle
  operaciones.delivery
  operaciones.movimiento_stock
  operaciones.stock_por_producto_sucursal
  operaciones.venta
  operaciones.venta_item
  operaciones.vuelto
  operaciones.vuelto_item
)

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-host) SOURCE_HOST="$2"; shift 2;;
    --source-user) SOURCE_USER="$2"; shift 2;;
    --source-pg-port) SOURCE_PG_PORT="$2"; shift 2;;
    --source-db) SOURCE_DB="$2"; shift 2;;
    --target-host) TARGET_HOST="$2"; shift 2;;
    --target-user) TARGET_USER="$2"; shift 2;;
    --target-pg-port) TARGET_PG_PORT="$2"; shift 2;;
    --target-db) TARGET_DB="$2"; shift 2;;
    --sucursal-id) SUCURSAL_ID="$2"; shift 2;;
    --from-publication) FROM_PUBLICATION="$2"; shift 2;;
    --pg-superuser) PG_SUPERUSER="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    -h|--help) grep '^#' "$0" | sed 's/^# \?//'; exit 0;;
    *) echo "Arg desconocido: $1" >&2; exit 2;;
  esac
done

fail(){ echo "ERROR: $*" >&2; exit 1; }
log(){ echo -e "\033[1;36m[$(date +%H:%M:%S)]\033[0m $*"; }

[[ -n "$SOURCE_HOST" && -n "$SOURCE_DB" ]] || fail "faltan --source-host / --source-db"
[[ -n "$TARGET_HOST" ]] || fail "falta --target-host"
[[ -n "$SUCURSAL_ID" ]] || fail "falta --sucursal-id"

SRC_SSH="${SOURCE_USER}@${SOURCE_HOST}"
DST_SSH="${TARGET_USER}@${TARGET_HOST}"
# psql local en cada host (sin pass: peer auth para el superuser; franco por PGPASSWORD si hiciera falta)
SRC_PSQL="sudo -u ${PG_SUPERUSER} psql -p ${SOURCE_PG_PORT} -d ${SOURCE_DB} -tAc"
DST_PSQL_ADMIN="sudo -u ${PG_SUPERUSER} psql -p ${TARGET_PG_PORT} -d postgres -tAc"
DST_PSQL_DB="sudo -u ${PG_SUPERUSER} psql -p ${TARGET_PG_PORT} -d ${TARGET_DB} -tAc"

# ---------------------------------------------------------------------------
# Fase 0 — Preflight
# ---------------------------------------------------------------------------
log "Preflight…"
ssh -o BatchMode=yes "$SRC_SSH" "command -v pg_dump >/dev/null" || fail "pg_dump no está en source ($SRC_SSH)"
ssh -o BatchMode=yes "$DST_SSH" "command -v pg_restore >/dev/null" || fail "pg_restore no está en target ($DST_SSH)"

# source DB existe + la sucursal existe en el maestro
SUC_OK=$(ssh "$SRC_SSH" "$SRC_PSQL \"SELECT count(*) FROM empresarial.sucursal WHERE id=${SUCURSAL_ID};\"" 2>/dev/null || echo "0")
[[ "$SUC_OK" == "1" ]] || fail "sucursal_id=${SUCURSAL_ID} NO existe en ${SOURCE_DB}.empresarial.sucursal. Creala primero en el central (es dato maestro)."
log "sucursal_id=${SUCURSAL_ID} presente en el maestro ✓"

# ---------------------------------------------------------------------------
# Derivar lista de exclusión (operativas por-sucursal)
# ---------------------------------------------------------------------------
if [[ -n "$FROM_PUBLICATION" ]]; then
  log "Derivando lista operativa VIVA desde publicación ${FROM_PUBLICATION}…"
  OPERATIONAL=()
  while IFS= read -r _t; do [[ -n "$_t" ]] && OPERATIONAL+=("$_t"); done < <(ssh "$SRC_SSH" "$SRC_PSQL \"SELECT schemaname||'.'||tablename FROM pg_publication_tables WHERE pubname='${FROM_PUBLICATION}' ORDER BY 1;\"")
  [[ ${#OPERATIONAL[@]} -gt 0 ]] || fail "la publicación ${FROM_PUBLICATION} no existe o no tiene tablas"
else
  log "Usando lista operativa por DEFECTO (27 tablas de central_filial25_pub)."
  OPERATIONAL=("${DEFAULT_OPERATIONAL[@]}")
fi
log "Tablas operativas a dejar VACÍAS: ${#OPERATIONAL[@]}"
printf '   - %s\n' "${OPERATIONAL[@]}"

# Construir flags de pg_dump
SCHEMA_FLAGS=(); for s in "${FILIAL_SCHEMAS[@]}"; do SCHEMA_FLAGS+=(-n "$s"); done
EXCLUDE_FLAGS=(); for t in "${OPERATIONAL[@]}"; do EXCLUDE_FLAGS+=(--exclude-table-data="$t"); done

PGDUMP_CMD="pg_dump -Fc --no-owner --no-privileges --no-publications --no-subscriptions \
  ${SCHEMA_FLAGS[*]} ${EXCLUDE_FLAGS[*]} -p ${SOURCE_PG_PORT} -d ${SOURCE_DB} -f ${DUMP_REMOTE}"

echo
log "Plan:"
echo "   SOURCE : ${SRC_SSH}  PG ${SOURCE_PG_PORT}/${SOURCE_DB}"
echo "   TARGET : ${DST_SSH}  PG ${TARGET_PG_PORT}/${TARGET_DB}  (se DROP/CREATE)"
echo "   sucursal_id destino: ${SUCURSAL_ID}"
echo "   schemas: ${FILIAL_SCHEMAS[*]}"
echo

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN. Comando de dump que se ejecutaría en el source:"
  echo "   sudo -u ${PG_SUPERUSER} ${PGDUMP_CMD}"
  exit 0
fi

if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "⚠️  Esto DROPEA y recrea ${TARGET_DB} en ${TARGET_HOST}. ¿Continuar? (escribí 'si'): " ans
  [[ "$ans" == "si" ]] || { echo "Cancelado."; exit 0; }
fi

# ---------------------------------------------------------------------------
# Fase 1 — Dump en el SOURCE (local, sobre localhost)
# ---------------------------------------------------------------------------
log "Fase 1: pg_dump en ${SOURCE_HOST} (maestro + schema, operativas vacías)…"
ssh "$SRC_SSH" "sudo -u ${PG_SUPERUSER} ${PGDUMP_CMD}"
DUMP_SIZE=$(ssh "$SRC_SSH" "sudo -u ${PG_SUPERUSER} ls -lh ${DUMP_REMOTE} | awk '{print \$5}'")
log "Dump generado (${DUMP_SIZE})."

# ---------------------------------------------------------------------------
# Fase 2 — Transferir SOURCE -> (relay) -> TARGET
# ---------------------------------------------------------------------------
LOCAL_TMP="$(mktemp -d)/filial-seed.dump"
log "Fase 2: transfiriendo dump al target vía relay local…"
ssh "$SRC_SSH" "sudo -u ${PG_SUPERUSER} cat ${DUMP_REMOTE}" > "$LOCAL_TMP"
scp -q "$LOCAL_TMP" "${DST_SSH}:${DUMP_REMOTE}"
log "Dump en target: ${DUMP_REMOTE}"

# ---------------------------------------------------------------------------
# Fase 3 — Recrear DB + restore en el TARGET (local)
# ---------------------------------------------------------------------------
log "Fase 3: backup de ${TARGET_DB} previo (si existe) + DROP/CREATE + restore…"
ssh "$DST_SSH" "bash -s" <<REMOTE
set -e
# backup previo si la DB existe (no borrar nada sin respaldo)
if sudo -u ${PG_SUPERUSER} psql -p ${TARGET_PG_PORT} -lqtA | cut -d'|' -f1 | grep -qx ${TARGET_DB}; then
  ts=\$(date +%F-%H%M%S)
  sudo -u ${PG_SUPERUSER} pg_dump -Fc -p ${TARGET_PG_PORT} -d ${TARGET_DB} -f /tmp/${TARGET_DB}-pre-provision-\${ts}.dump || true
  echo "backup previo: /tmp/${TARGET_DB}-pre-provision-\${ts}.dump"
  # cerrar conexiones + drop
  sudo -u ${PG_SUPERUSER} psql -p ${TARGET_PG_PORT} -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TARGET_DB}' AND pid<>pg_backend_pid();" >/dev/null
  sudo -u ${PG_SUPERUSER} psql -p ${TARGET_PG_PORT} -d postgres -c "DROP DATABASE IF EXISTS ${TARGET_DB};"
fi
sudo -u ${PG_SUPERUSER} psql -p ${TARGET_PG_PORT} -d postgres -c "CREATE DATABASE ${TARGET_DB};"
# restore (constraints/FKs se crean tras la data → dependencias circulares OK)
sudo -u ${PG_SUPERUSER} pg_restore --no-owner --no-privileges -p ${TARGET_PG_PORT} -d ${TARGET_DB} ${DUMP_REMOTE} 2>&1 | tail -5 || true
REMOTE

# ---------------------------------------------------------------------------
# Fase 4 — Verificación
# ---------------------------------------------------------------------------
log "Fase 4: verificación (operativas=0, maestro>0)…"
ssh "$DST_SSH" "bash -s" <<REMOTE
set -e
q(){ sudo -u ${PG_SUPERUSER} psql -p ${TARGET_PG_PORT} -d ${TARGET_DB} -tAc "\$1"; }
echo "  maestro:"
for t in productos.producto productos.presentacion empresarial.sucursal personas.usuario productos.precio_por_sucursal; do
  printf "    %-32s %s\n" "\$t" "\$(q "SELECT count(*) FROM \$t;" 2>/dev/null || echo ERR)"
done
echo "  operativas (deben ser 0):"
for t in operaciones.venta operaciones.venta_item financiero.pdv_caja configuraciones.inicio_sesion operaciones.movimiento_stock; do
  printf "    %-32s %s\n" "\$t" "\$(q "SELECT count(*) FROM \$t;" 2>/dev/null || echo ERR)"
done
echo "  sucursal destino existe:"
q "SELECT id||' '||nombre FROM empresarial.sucursal WHERE id=${SUCURSAL_ID};"
REMOTE

rm -f "$LOCAL_TMP"; rmdir "$(dirname "$LOCAL_TMP")" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Siguientes pasos (NO automatizados)
# ---------------------------------------------------------------------------
cat <<NEXT

=============================================================================
✅ DB '${TARGET_DB}' provisionada en ${TARGET_HOST} (maestro cargado, operativas vacías).

SIGUIENTES PASOS (manuales, ver runbook-migracion-filial-linux-beta.md):

1) application.properties overlay en la filial:
     sucursalId=${SUCURSAL_ID}
     ipServidorCentral=central:8082        # MagicDNS headscale (no IP ZeroTier/pública)

2) Replicación lógica central<->filial (usar nombre MagicDNS 'central' en la CONNECTION):
   En el CENTRAL (${SOURCE_DB}):
     CREATE PUBLICATION central_filial${SUCURSAL_ID}_pub;
     -- ADD TABLE por cada operativa de la lista (${#OPERATIONAL[@]} tablas)
   En la FILIAL (${TARGET_DB}):
     CREATE SUBSCRIPTION filial${SUCURSAL_ID}_sub
       CONNECTION 'host=central port=${SOURCE_PG_PORT} dbname=${SOURCE_DB} user=franco password=***'
       PUBLICATION central_filial${SUCURSAL_ID}_pub;

3) Ajustar sequences si hiciera falta (setval) y verificar arranque del backend.
=============================================================================
NEXT
log "Listo."
