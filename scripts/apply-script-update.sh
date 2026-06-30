#!/usr/bin/env bash
# apply-script-update.sh
#
# Propaga cambios del script check-update.{sh,ps1} a TODAS las filiales registradas
# en .env. Útil cuando se modifica el script "fuente de verdad" en este repo y hay
# que sincronizar las copias locales que cada filial tiene en disco.
#
# Estrategia: en vez de copiar el archivo entero, aplica sed/replace puntual sobre
# variables específicas. Esto preserva customizaciones locales y reduce el blast
# radius de un push de script roto.
#
# Configuración del cambio: editar la sección APPLY_LINUX y APPLY_WINDOWS abajo
# antes de cada ejecución, según qué línea querés cambiar.
#
# Uso:
#   ./scripts/apply-script-update.sh             # interactivo, pide confirmación
#   ./scripts/apply-script-update.sh --yes       # no pregunta
#   ./scripts/apply-script-update.sh --only=farmacia   # solo filiales farmacia
#   ./scripts/apply-script-update.sh --only=bodega     # solo filiales bodega
#
# Requiere: sshpass instalado, .env con FILIAL_*_HOST/_PASS poblado.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

# ============================================================================
# CONFIGURACIÓN
# ============================================================================
# Estrategia: scp del archivo entero desde el repo a cada filial. Sincroniza
# las copias locales a la "fuente de verdad". Más confiable que sed remoto
# (especialmente en Windows, donde el escape PS+SSH+CMD se complica).
# Trampa: sobreescribe customizaciones locales del script si las hubiera.

LINUX_SOURCE="${SCRIPT_DIR}/check-update.sh"
LINUX_TARGET="/opt/frc-filial/check-update.sh"
WINDOWS_SOURCE="${SCRIPT_DIR}/check-update.ps1"
WINDOWS_TARGET="C:/frc-filial/check-update.ps1"

DESCRIPTION="sincronizar check-update.{sh,ps1} a fuente del repo"
VERIFY_LINUX="grep '^HEALTH_TIMEOUT=' ${LINUX_TARGET}"
VERIFY_WINDOWS='powershell -Command "Select-String -Path C:\\frc-filial\\check-update.ps1 -Pattern ^.HEALTH_TIMEOUT"'

if [[ ! -f "${LINUX_SOURCE}" || ! -f "${WINDOWS_SOURCE}" ]]; then
  echo "ERROR: source scripts not found in ${SCRIPT_DIR}" >&2
  exit 1
fi

# ============================================================================
# Inventario de filiales
# Format: "label os ip pass"
# ============================================================================

FILIALES=(
  "farmacia-1   linux   ${FILIAL_1_HOST:-}   ${FILIAL_1_PASS:-}"
  "farmacia-2   windows ${FILIAL_2_HOST:-}   ${FILIAL_2_PASS:-}"
  "farmacia-3   linux   ${FILIAL_3_HOST:-}   ${FILIAL_3_PASS:-}"
  "farmacia-4   linux   ${FILIAL_4_HOST:-}   ${FILIAL_4_PASS:-}"
  "farmacia-5   linux   ${FILIAL_5_HOST:-}   ${FILIAL_5_PASS:-}"
  "bodega-1     linux   ${BODEGA_FILIAL_1_HOST:-}   ${BODEGA_FILIAL_1_PASS:-}"
  "bodega-3     linux   ${BODEGA_FILIAL_3_HOST:-}   ${BODEGA_FILIAL_3_PASS:-}"
  "bodega-4     windows ${BODEGA_FILIAL_4_HOST:-}   ${BODEGA_FILIAL_4_PASS:-}"
  "bodega-5     linux   ${BODEGA_FILIAL_5_HOST:-}   ${BODEGA_FILIAL_5_PASS:-}"
  "bodega-6     linux   ${BODEGA_FILIAL_6_HOST:-}   ${BODEGA_FILIAL_6_PASS:-}"
  "bodega-7     linux   ${BODEGA_FILIAL_7_HOST:-}   ${BODEGA_FILIAL_7_PASS:-}"
  "bodega-8     linux   ${BODEGA_FILIAL_8_HOST:-}   ${BODEGA_FILIAL_8_PASS:-}"
  "bodega-9     linux   ${BODEGA_FILIAL_9_HOST:-}   ${BODEGA_FILIAL_9_PASS:-}"
  "bodega-10    linux   ${BODEGA_FILIAL_10_HOST:-}  ${BODEGA_FILIAL_10_PASS:-}"
  "bodega-11    linux   ${BODEGA_FILIAL_11_HOST:-}  ${BODEGA_FILIAL_11_PASS:-}"
  "bodega-12    linux   ${BODEGA_FILIAL_12_HOST:-}  ${BODEGA_FILIAL_12_PASS:-}"
  "bodega-14    linux   ${BODEGA_FILIAL_14_HOST:-}  ${BODEGA_FILIAL_14_PASS:-}"
  "bodega-18    linux   ${BODEGA_FILIAL_18_HOST:-}  ${BODEGA_FILIAL_18_PASS:-}"
  "bodega-20    linux   ${BODEGA_FILIAL_20_HOST:-}  ${BODEGA_FILIAL_20_PASS:-}"
  "bodega-21    linux   ${BODEGA_FILIAL_21_HOST:-}  ${BODEGA_FILIAL_21_PASS:-}"
  "bodega-22    linux   ${BODEGA_FILIAL_22_HOST:-}  ${BODEGA_FILIAL_22_PASS:-}"
  "bodega-23    linux   ${BODEGA_FILIAL_23_HOST:-}  ${BODEGA_FILIAL_23_PASS:-}"
  "bodega-24    linux   ${BODEGA_FILIAL_24_HOST:-}  ${BODEGA_FILIAL_24_PASS:-}"
)

# ============================================================================
# Args
# ============================================================================
AUTO_YES=false
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true;;
    --only=*) ONLY="${arg#*=}";;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0;;
    *) echo "Unknown arg: $arg" >&2; exit 1;;
  esac
done

# ============================================================================
# Confirmación
# ============================================================================
echo "Cambio a aplicar: ${DESCRIPTION}"
echo "Linux:   scp ${LINUX_SOURCE##*/} → franco@<host>:${LINUX_TARGET}"
echo "Windows: scp ${WINDOWS_SOURCE##*/} → franco@<host>:${WINDOWS_TARGET}"
echo ""

count=0
for entry in "${FILIALES[@]}"; do
  read -r label os ip pass <<<"$entry"
  [[ -n "$ONLY" && "$label" != $ONLY* ]] && continue
  [[ -z "$ip" ]] && continue
  count=$((count+1))
done
echo "Filiales a actualizar: ${count}"
[[ -n "$ONLY" ]] && echo "Filtro: --only=${ONLY}"
echo ""

if [[ "$AUTO_YES" != "true" ]]; then
  read -rp "¿Continuar? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }
fi

# ============================================================================
# Aplicación
# ============================================================================
OK_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILED_LABELS=()

for entry in "${FILIALES[@]}"; do
  read -r label os ip pass <<<"$entry"
  if [[ -n "$ONLY" && "$label" != $ONLY* ]]; then
    continue
  fi
  if [[ -z "$ip" || -z "$pass" ]]; then
    echo "[SKIP] $label — sin IP/pass en .env"
    SKIP_COUNT=$((SKIP_COUNT+1))
    continue
  fi

  printf "→ %-14s %-7s %-15s ... " "$label" "$os" "$ip"

  case "$os" in
    linux)
      src="${LINUX_SOURCE}"; tgt="${LINUX_TARGET}"; verify="${VERIFY_LINUX}"
      ;;
    windows)
      src="${WINDOWS_SOURCE}"; tgt="${WINDOWS_TARGET}"; verify="${VERIFY_WINDOWS}"
      ;;
    *)
      echo "OS desconocido: $os"; FAIL_COUNT=$((FAIL_COUNT+1)); continue
      ;;
  esac

  scp_out=$(sshpass -p "$pass" scp -o StrictHostKeyChecking=no -o ConnectTimeout=8 \
            "${src}" "franco@${ip}:${tgt}" 2>&1)
  scp_rc=$?

  if [[ $scp_rc -ne 0 ]]; then
    echo "FAIL scp (rc=$scp_rc)"
    echo "    $(echo "$scp_out" | head -2 | sed 's/^/    /')"
    FAIL_COUNT=$((FAIL_COUNT+1))
    FAILED_LABELS+=("$label")
    continue
  fi

  verify_out=$(sshpass -p "$pass" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 \
               franco@"$ip" "$verify" 2>&1)
  verify_rc=$?

  if [[ $verify_rc -eq 0 ]]; then
    echo "OK — $(echo "$verify_out" | tr -d '\r' | tail -1 | xargs)"
    OK_COUNT=$((OK_COUNT+1))
  else
    echo "FAIL verify (rc=$verify_rc)"
    echo "    $(echo "$verify_out" | tr -d '\r' | head -3 | sed 's/^/    /')"
    FAIL_COUNT=$((FAIL_COUNT+1))
    FAILED_LABELS+=("$label")
  fi
done

echo ""
echo "============================================"
echo "Resumen: ${OK_COUNT} OK, ${FAIL_COUNT} FAIL, ${SKIP_COUNT} SKIP"
if (( FAIL_COUNT > 0 )); then
  echo "Filiales que fallaron: ${FAILED_LABELS[*]}"
  exit 1
fi
exit 0
