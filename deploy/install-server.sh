#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="ArronHC/MailCollector"
INSTALL_DIR="${MAIL_COLLECTOR_INSTALL_DIR:-/opt/mail-collector}"
SOURCE_DIR="${INSTALL_DIR}/source"
STATE_DIR="${INSTALL_DIR}/state"
ENV_FILE="${STATE_DIR}/server.env"
SOURCE_REF="${MAIL_COLLECTOR_REF:-}"

fail() {
  printf 'Mail Collector installation failed: %s\n' "$1" >&2
  exit 1
}

compose_v1_supported() {
  local version
  command -v docker-compose >/dev/null 2>&1 || return 1
  version="$(docker-compose version --short 2>/dev/null)" || return 1
  version="${version#v}"
  dpkg --compare-versions "${version}" ge 1.25.0
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "run this script as root, for example: curl ... | sudo bash"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  fail "the automatic installer currently supports Debian and Ubuntu systems"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl openssl tar

if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends docker.io
fi

if ! docker compose version >/dev/null 2>&1 && ! compose_v1_supported; then
  if ! apt-get install -y --no-install-recommends docker-compose-v2; then
    if ! apt-get install -y --no-install-recommends docker-compose-plugin; then
      apt-get install -y --no-install-recommends docker-compose
    fi
  fi
fi

if ! docker info >/dev/null 2>&1; then
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker || fail "Docker is installed but could not be started with systemd"
  elif command -v service >/dev/null 2>&1; then
    service docker start || fail "Docker is installed but could not be started"
  fi
fi
docker info >/dev/null 2>&1 || fail "Docker daemon is not available"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif compose_v1_supported; then
  COMPOSE=(docker-compose)
else
  fail "Docker Compose v2 or docker-compose 1.25.0+ is required"
fi

if [[ ! "${INSTALL_DIR}" =~ ^/[a-zA-Z0-9._/-]+$ ]]; then
  fail "MAIL_COLLECTOR_INSTALL_DIR must be an absolute path using letters, numbers, dots, underscores, hyphens, and slashes"
fi

mkdir -p "${INSTALL_DIR}" "${STATE_DIR}/data" "${STATE_DIR}/caddy-data" "${STATE_DIR}/caddy-config"
chmod 700 "${STATE_DIR}"
chown -R 1000:1000 "${STATE_DIR}/data"

read_existing() {
  local name="$1"
  local source_file="${READ_ENV_FILE:-${ENV_FILE}}"
  [[ -f "${source_file}" ]] || return 0
  sed -n "s/^${name}=//p" "${source_file}" | tail -n 1
}

setting() {
  local name="$1"
  local fallback="$2"
  local environment_value="${!name:-}"
  local existing_value
  existing_value="$(read_existing "${name}")"
  printf '%s' "${environment_value:-${existing_value:-${fallback}}}"
}

valid_domain() {
  local domain="$1"
  local label
  local -a labels
  [[ "${#domain}" -le 253 && "${domain}" == *.* ]] || return 1
  IFS='.' read -r -a labels <<<"${domain}"
  for label in "${labels[@]}"; do
    [[ "${#label}" -le 63 && "${label}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}

SOURCE_REF="${SOURCE_REF:-$(read_existing MAIL_COLLECTOR_REF)}"
SOURCE_REF="${SOURCE_REF:-main}"
[[ "${SOURCE_REF}" =~ ^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$ ]] || fail "MAIL_COLLECTOR_REF must be main or a release tag that is also a valid Docker image tag"

DOMAIN="${MAIL_COLLECTOR_DOMAIN:-$(read_existing MAIL_COLLECTOR_DOMAIN)}"
if [[ -z "${DOMAIN}" ]]; then
  if [[ ! -r /dev/tty ]]; then
    fail "set MAIL_COLLECTOR_DOMAIN when running non-interactively"
  fi
  read -r -p "Mail Collector domain (for example mail.example.com): " DOMAIN </dev/tty
fi
DOMAIN="${DOMAIN,,}"
if ! valid_domain "${DOMAIN}"; then
  fail "invalid domain name: ${DOMAIN}"
fi

ENCRYPTION_KEY="${MAIL_COLLECTOR_ENCRYPTION_KEY:-$(read_existing ENCRYPTION_KEY)}"
API_KEY="${MAIL_COLLECTOR_API_KEY:-$(read_existing API_KEY)}"
INVITE_CODE="${MAIL_COLLECTOR_INVITE_CODE:-$(read_existing REGISTRATION_INVITE_CODE)}"
ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
API_KEY="${API_KEY:-$(openssl rand -hex 32)}"
INVITE_CODE="${INVITE_CODE:-MC-$(openssl rand -hex 10)}"

[[ "${ENCRYPTION_KEY}" =~ ^[a-fA-F0-9]{64}$ ]] || fail "ENCRYPTION_KEY must contain 64 hexadecimal characters"
[[ "${API_KEY}" =~ ^[a-zA-Z0-9._~-]{24,}$ ]] || fail "API_KEY must contain at least 24 letters, numbers, dots, underscores, tildes, or hyphens"
[[ "${INVITE_CODE}" =~ ^[a-zA-Z0-9._~-]{12,}$ ]] || fail "REGISTRATION_INVITE_CODE must contain at least 12 letters, numbers, dots, underscores, tildes, or hyphens"

if [[ -f "${ENV_FILE}" ]]; then
  cp "${ENV_FILE}" "${ENV_FILE}.bak"
  READ_ENV_FILE="${ENV_FILE}.bak"
fi

cat >"${ENV_FILE}" <<EOF
MAIL_COLLECTOR_DOMAIN=${DOMAIN}
MAIL_COLLECTOR_STATE_DIR=${STATE_DIR}
MAIL_COLLECTOR_REF=${SOURCE_REF}
MAIL_COLLECTOR_IMAGE_TAG=${SOURCE_REF//\//-}
MAIL_COLLECTOR_HTTP_PORT=$(setting MAIL_COLLECTOR_HTTP_PORT 80)
MAIL_COLLECTOR_HTTPS_PORT=$(setting MAIL_COLLECTOR_HTTPS_PORT 443)

HOST=0.0.0.0
PORT=3000
DATABASE_PATH=/data/mail-collector.db
ENCRYPTION_KEY=${ENCRYPTION_KEY}
API_KEY=${API_KEY}
REGISTRATION_INVITE_CODE=${INVITE_CODE}

ALLOW_REMOTE_CLIENTS=true
ALLOWED_REMOTE_ORIGINS=$(setting ALLOWED_REMOTE_ORIGINS '')
TRUSTED_PROXY=uniquelocal
REQUIRE_HTTPS=true
ALLOW_PRIVATE_MAIL_HOSTS=$(setting ALLOW_PRIVATE_MAIL_HOSTS false)

SYNC_INTERVAL_MINUTES=$(setting SYNC_INTERVAL_MINUTES 5)
INITIAL_SYNC_LIMIT=$(setting INITIAL_SYNC_LIMIT 100)
MAX_MESSAGE_BYTES=$(setting MAX_MESSAGE_BYTES 10485760)
BACKFILL_PAGE_SIZE=$(setting BACKFILL_PAGE_SIZE 100)
RECONCILE_MESSAGE_LIMIT=$(setting RECONCILE_MESSAGE_LIMIT 500)
ACTIVE_RECONCILE_MINUTES=$(setting ACTIVE_RECONCILE_MINUTES 30)
NORMAL_RECONCILE_MINUTES=$(setting NORMAL_RECONCILE_MINUTES 180)
INACTIVE_RECONCILE_MINUTES=$(setting INACTIVE_RECONCILE_MINUTES 720)
SYNC_LEASE_SECONDS=$(setting SYNC_LEASE_SECONDS 300)
PROVIDER_MAX_ATTEMPTS=$(setting PROVIDER_MAX_ATTEMPTS 5)
PROVIDER_MAX_CONCURRENCY=$(setting PROVIDER_MAX_CONCURRENCY 3)
MAIL_WORKER_INTERVAL_SECONDS=$(setting MAIL_WORKER_INTERVAL_SECONDS 2)
IMAP_IDLE_ENABLED=$(setting IMAP_IDLE_ENABLED true)
IMAP_IDLE_SCAN_SECONDS=$(setting IMAP_IDLE_SCAN_SECONDS 30)
IMAP_IDLE_DEBOUNCE_MS=$(setting IMAP_IDLE_DEBOUNCE_MS 750)
IMAP_IDLE_RECONNECT_MAX_SECONDS=$(setting IMAP_IDLE_RECONNECT_MAX_SECONDS 300)
EOF
chmod 600 "${ENV_FILE}"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT
if [[ "${SOURCE_REF}" == "main" ]]; then
  ARCHIVE_URL="https://github.com/${REPOSITORY}/archive/refs/heads/main.tar.gz"
else
  ARCHIVE_URL="https://github.com/${REPOSITORY}/archive/refs/tags/${SOURCE_REF}.tar.gz"
fi
printf 'Downloading Mail Collector %s...\n' "${SOURCE_REF}"
curl --fail --silent --show-error --location "${ARCHIVE_URL}" --output "${TEMP_DIR}/source.tar.gz"
mkdir -p "${TEMP_DIR}/source"
tar -xzf "${TEMP_DIR}/source.tar.gz" -C "${TEMP_DIR}/source" --strip-components=1

"${COMPOSE[@]}" --project-name mail-collector --env-file "${ENV_FILE}" -f "${TEMP_DIR}/source/deploy/docker-compose.server.yml" config >/dev/null

rm -rf "${SOURCE_DIR}.new"
mv "${TEMP_DIR}/source" "${SOURCE_DIR}.new"
rm -rf "${SOURCE_DIR}"
mv "${SOURCE_DIR}.new" "${SOURCE_DIR}"

printf 'Building and starting Mail Collector...\n'
"${COMPOSE[@]}" --project-name mail-collector --env-file "${ENV_FILE}" -f "${SOURCE_DIR}/deploy/docker-compose.server.yml" pull caddy
"${COMPOSE[@]}" --project-name mail-collector --env-file "${ENV_FILE}" -f "${SOURCE_DIR}/deploy/docker-compose.server.yml" build --pull mail-collector
"${COMPOSE[@]}" --project-name mail-collector --env-file "${ENV_FILE}" -f "${SOURCE_DIR}/deploy/docker-compose.server.yml" up -d --force-recreate --remove-orphans

cat >"${INSTALL_DIR}/compose.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
if docker compose version >/dev/null 2>&1; then
  exec docker compose --project-name mail-collector --env-file "${ENV_FILE}" -f "${SOURCE_DIR}/deploy/docker-compose.server.yml" "\$@"
fi
exec docker-compose --project-name mail-collector --env-file "${ENV_FILE}" -f "${SOURCE_DIR}/deploy/docker-compose.server.yml" "\$@"
EOF
chmod 755 "${INSTALL_DIR}/compose.sh"

printf '\nMail Collector server is installed.\n'
printf 'URL: https://%s\n' "${DOMAIN}"
printf 'API Key: %s\n' "${API_KEY}"
printf 'Registration invite code: %s\n' "${INVITE_CODE}"
printf 'Configuration: %s\n' "${ENV_FILE}"
printf 'Data directory: %s\n' "${STATE_DIR}/data"
printf 'Management command: sudo %s/compose.sh\n' "${INSTALL_DIR}"
printf '\nEnsure DNS points to this server and TCP ports 80/443 are open. Caddy will obtain the HTTPS certificate automatically.\n'
