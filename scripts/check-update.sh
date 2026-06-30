#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# FRC Filial Server — Auto-Update Script
# Runs via cron every 15 minutes to check for new releases
# Usage: /opt/frc-filial/check-update.sh
# ============================================================

BASE_DIR="/opt/frc-filial"
RELEASES_DIR="${BASE_DIR}/releases"
CURRENT_LINK="${BASE_DIR}/current"
VERSION_FILE="${BASE_DIR}/.current-version"
CHANNEL_FILE="${BASE_DIR}/.channel"
TOKEN_FILE="${BASE_DIR}/.github-token"
FILIAL_ID_FILE="${BASE_DIR}/.filial-id"
LOG_FILE="${BASE_DIR}/logs/update.log"
JAR_NAME="frc-filial-server.jar"
# El unit systemd se llama frc.service en toda la flota (farmacia + bodega), y el
# NOPASSWD sudoers está configurado para frc.service. Usar frc-filial.service hace
# que `sudo systemctl restart` no matchee ninguna regla NOPASSWD -> pide password ->
# falla bajo cron y el servicio nunca se reinicia (drift: marker avanza, proceso no).
SERVICE_NAME="frc.service"
REPO="GabFrank/franco-system-backend-filial"
HEALTH_PORT=$(grep -s SERVER_PORT "${BASE_DIR}/.env" | cut -d= -f2 || echo "8080")
HEALTH_URL="http://localhost:${HEALTH_PORT}/actuator/health"
HEALTH_TIMEOUT=240
HEALTH_INTERVAL=5

# --- Logging ---
mkdir -p "$(dirname "${LOG_FILE}")"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo ""
echo "========== $(date '+%Y-%m-%d %H:%M:%S') =========="

# --- Validations ---
if [[ ! -f "${CHANNEL_FILE}" ]]; then
  echo "ERROR: Channel file not found at ${CHANNEL_FILE}"
  echo "Create it with: echo 'alpha' > ${CHANNEL_FILE}"
  exit 1
fi

if [[ ! -f "${TOKEN_FILE}" ]]; then
  echo "ERROR: GitHub token file not found at ${TOKEN_FILE}"
  exit 1
fi

CHANNEL=$(cat "${CHANNEL_FILE}" | tr -d '[:space:]')
TOKEN=$(cat "${TOKEN_FILE}" | tr -d '[:space:]')
FILIAL_ID=$(cat "${FILIAL_ID_FILE}" 2>/dev/null || hostname)
CURRENT_VERSION=$(cat "${VERSION_FILE}" 2>/dev/null || echo "none")

echo "Filial: ${FILIAL_ID}"
echo "Channel: ${CHANNEL}"
echo "Current version: ${CURRENT_VERSION}"

# --- GitHub Deployment API ---
notify_github() {
  local version="$1"
  local state="$2"  # success, failure
  local description="${3:-}"
  local environment="${FILIAL_ID}"

  # Create deployment
  local deploy_id
  deploy_id=$(curl -fsSL \
    -H "Authorization: token ${TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    -X POST "https://api.github.com/repos/${REPO}/deployments" \
    -d "{\"ref\":\"v${version}\",\"environment\":\"${environment}\",\"auto_merge\":false,\"required_contexts\":[],\"description\":\"Auto-update ${FILIAL_ID} to ${version}\"}" \
    2>/dev/null | jq -r '.id // empty') || true

  if [[ -n "${deploy_id}" ]]; then
    # Set deployment status
    curl -fsSL \
      -H "Authorization: token ${TOKEN}" \
      -H "Accept: application/vnd.github.v3+json" \
      -X POST "https://api.github.com/repos/${REPO}/deployments/${deploy_id}/statuses" \
      -d "{\"state\":\"${state}\",\"description\":\"${description}\"}" \
      >/dev/null 2>&1 || true
    echo "GitHub deployment notified: ${environment} → ${version} (${state})"
  fi
}

# --- Determine latest release for channel ---
# alpha = latest prerelease with -alpha in tag
# beta = latest prerelease with -beta in tag
# stable = latest non-prerelease
if [[ "${CHANNEL}" == "stable" ]]; then
  LATEST=$(curl -fsSL \
    -H "Authorization: token ${TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${REPO}/releases/latest" \
  | jq -r '.tag_name // empty')
else
  LATEST=$(curl -fsSL \
    -H "Authorization: token ${TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${REPO}/releases" \
  | jq -r --arg ch "${CHANNEL}" '[.[] | select(.prerelease == true and (.tag_name | contains($ch)))][0].tag_name // empty')
fi

if [[ -z "${LATEST}" ]]; then
  echo "No release found for channel '${CHANNEL}'. Skipping."
  exit 0
fi

# Strip 'v' prefix for comparison
LATEST_VERSION="${LATEST#v}"

echo "Latest version for ${CHANNEL}: ${LATEST_VERSION}"

if [[ "${CURRENT_VERSION}" == "${LATEST_VERSION}" ]]; then
  echo "Already up to date. Nothing to do."
  exit 0
fi

echo "New version available: ${LATEST_VERSION} (current: ${CURRENT_VERSION})"

# --- Download JAR ---
RELEASE_DIR="${RELEASES_DIR}/${LATEST_VERSION}"
mkdir -p "${RELEASE_DIR}"

echo "Downloading ${JAR_NAME} from release ${LATEST}..."
ASSET_URL=$(curl -fsSL \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${REPO}/releases/tags/${LATEST}" \
| jq -r --arg name "${JAR_NAME}" '.assets[] | select(.name == $name) | .url // empty')

if [[ -z "${ASSET_URL}" ]]; then
  echo "ERROR: JAR asset '${JAR_NAME}' not found in release ${LATEST}"
  exit 1
fi

curl -fsSL \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/octet-stream" \
  -o "${RELEASE_DIR}/${JAR_NAME}" \
  "${ASSET_URL}"

echo "Downloaded to ${RELEASE_DIR}/${JAR_NAME} ($(du -h "${RELEASE_DIR}/${JAR_NAME}" | cut -f1))"

# --- Deploy ---
PREVIOUS_VERSION="${CURRENT_VERSION}"

echo "Updating symlink: current -> ${RELEASE_DIR}"
ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
# .current-version is written only after the running jar is verified below, so a
# failed restart can never leave the marker ahead of the live process.

echo "Restarting ${SERVICE_NAME}..."
sudo systemctl restart "${SERVICE_NAME}"

# --- Health check ---
echo "Waiting for health check at ${HEALTH_URL} (timeout: ${HEALTH_TIMEOUT}s)..."
ELAPSED=0
while [[ ${ELAPSED} -lt ${HEALTH_TIMEOUT} ]]; do
  sleep "${HEALTH_INTERVAL}"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo "000")

  if [[ "${HTTP_STATUS}" == "200" || "${HTTP_STATUS}" == "503" ]]; then
    # Verify the RUNNING jar is actually the new version; /actuator/health alone
    # gives a false positive when a stale process is still answering on the port.
    RUNNING_VERSION=$(curl -s "http://localhost:${HEALTH_PORT}/api/version" 2>/dev/null | jq -r '.version // empty')
    if [[ "${RUNNING_VERSION}" != "${LATEST_VERSION}" ]]; then
      echo "Health ${HTTP_STATUS} but running version '${RUNNING_VERSION}' != ${LATEST_VERSION}; still booting, retrying..."
      continue
    fi
    echo "${LATEST_VERSION}" > "${VERSION_FILE}"
    echo "Health check PASSED (HTTP ${HTTP_STATUS}, version ${RUNNING_VERSION}) at ${ELAPSED}s"
    echo "Successfully updated to ${LATEST_VERSION}"
    notify_github "${LATEST_VERSION}" "success" "Health check passed (HTTP ${HTTP_STATUS})"
    exit 0
  fi
done

# --- Health check failed — Rollback ---
echo "ERROR: Health check failed after ${HEALTH_TIMEOUT}s"

if [[ "${PREVIOUS_VERSION}" != "none" && -d "${RELEASES_DIR}/${PREVIOUS_VERSION}" ]]; then
  echo "Rolling back to ${PREVIOUS_VERSION}..."
  ln -sfn "${RELEASES_DIR}/${PREVIOUS_VERSION}" "${CURRENT_LINK}"
  echo "${PREVIOUS_VERSION}" > "${VERSION_FILE}"
  sudo systemctl restart "${SERVICE_NAME}"
  echo "Rollback complete. Service restarted with version ${PREVIOUS_VERSION}"
  notify_github "${LATEST_VERSION}" "failure" "Health check failed, rolled back to ${PREVIOUS_VERSION}"
else
  echo "WARNING: No previous version to rollback to. Manual intervention required."
fi

exit 1
