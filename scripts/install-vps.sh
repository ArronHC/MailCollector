#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${MAIL_COLLECTOR_DIR:-/opt/mail-collector}"
IMAGE="${MAIL_COLLECTOR_IMAGE:-ghcr.io/arronhc/mailcollector:latest}"
DOMAIN="${MAIL_COLLECTOR_DOMAIN:-}"
EMAIL="${MAIL_COLLECTOR_ACME_EMAIL:-}"
FORCE=0
PROXY_MODE="${MAIL_COLLECTOR_PROXY_MODE:-auto}"
LOCAL_PORT="${MAIL_COLLECTOR_LOCAL_PORT:-18080}"

usage() {
  cat <<'EOF'
Mail Collector VPS one-click installer

Quick install:
  curl -fsSL https://raw.githubusercontent.com/ArronHC/MailCollector/main/scripts/install-vps.sh | sudo bash

Unattended install:
  sudo bash install-vps.sh --domain mail.example.com [--email you@example.com]

Options:
  --domain DOMAIN   Public HTTPS domain used by Windows/Android clients; prompts when omitted
  --email EMAIL     Optional ACME contact email for Caddy
  --dir PATH        Install directory (default: /opt/mail-collector)
  --image IMAGE     Container image (default: ghcr.io/arronhc/mailcollector:latest)
  --proxy-mode MODE Reverse proxy mode: auto, bundled, or external (default: auto)
  --local-port PORT Loopback port for an existing reverse proxy (default: 18080)
  --force           Overwrite generated compose/Caddy configuration, preserving .env secrets
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"; shift 2 ;;
    --email)
      EMAIL="${2:-}"; shift 2 ;;
    --dir)
      APP_DIR="${2:-}"; shift 2 ;;
    --image)
      IMAGE="${2:-}"; shift 2 ;;
    --proxy-mode)
      PROXY_MODE="${2:-}"; shift 2 ;;
    --local-port)
      LOCAL_PORT="${2:-}"; shift 2 ;;
    --force)
      FORCE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this installer as root (for example with sudo)." >&2
  exit 1
fi

if [[ -z "$DOMAIN" && -f "$APP_DIR/.env" ]]; then
  EXISTING_URL="$(sed -n 's/^OAUTH_REDIRECT_BASE_URL=//p' "$APP_DIR/.env" | head -n1)"
  DOMAIN="${EXISTING_URL#https://}"
  DOMAIN="${DOMAIN%/}"
fi

if [[ -z "$DOMAIN" ]]; then
  if [[ ! -r /dev/tty ]]; then
    echo "No interactive terminal is available. Re-run with --domain mail.example.com." >&2
    exit 2
  fi
  printf '\nMail Collector public domain (for example mail.example.com): ' > /dev/tty
  IFS= read -r DOMAIN < /dev/tty
fi

DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%/}"

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || [[ "$DOMAIN" != *.* ]]; then
  echo "Invalid domain: $DOMAIN" >&2
  exit 2
fi

if [[ "$PROXY_MODE" != "auto" && "$PROXY_MODE" != "bundled" && "$PROXY_MODE" != "external" ]]; then
  echo "--proxy-mode must be auto, bundled, or external" >&2
  exit 2
fi

if [[ ! "$LOCAL_PORT" =~ ^[0-9]+$ ]] || (( LOCAL_PORT < 1024 || LOCAL_PORT > 65535 )); then
  echo "--local-port must be between 1024 and 65535" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1 || { ! command -v openssl >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; }; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl
  else
    echo "curl and either openssl or python3 are required. Install them first and run the installer again." >&2
    exit 1
  fi
fi

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi
  echo "Installing Docker Engine and Compose plugin..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  fi
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 36 | tr -d '\n=+/' | cut -c1-48
  else
    python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(36))
PY
  fi
}

install_docker
mkdir -p "$APP_DIR/data" "$APP_DIR/caddy-data" "$APP_DIR/caddy-config"
chmod 700 "$APP_DIR"

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .
  else
    timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
  fi
}

OVERRIDE_FILE="$APP_DIR/compose.mailcollector-proxy.yaml"
MANAGED_OVERRIDE=0
if [[ -f "$OVERRIDE_FILE" ]]; then
  if head -n1 "$OVERRIDE_FILE" | grep -Fxq "# Managed by Mail Collector installer"; then
    MANAGED_OVERRIDE=1
    SAVED_LOCAL_PORT="$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\):8080.*/\1/p' "$OVERRIDE_FILE" | head -n1)"
    if [[ -n "$SAVED_LOCAL_PORT" ]]; then
      LOCAL_PORT="$SAVED_LOCAL_PORT"
    fi
  else
    echo "Refusing to overwrite unmanaged file: $OVERRIDE_FILE" >&2
    exit 1
  fi
fi

OWN_CADDY_RUNNING=0
if [[ -f "$APP_DIR/compose.yaml" ]] && (cd "$APP_DIR" && docker compose ps -q caddy 2>/dev/null | grep -q .); then
  OWN_CADDY_RUNNING=1
fi

if [[ "$PROXY_MODE" == "auto" ]]; then
  if [[ "$MANAGED_OVERRIDE" -eq 1 ]]; then
    PROXY_MODE="external"
  elif [[ "$OWN_CADDY_RUNNING" -eq 1 ]]; then
    PROXY_MODE="bundled"
  elif port_in_use 80 || port_in_use 443; then
    PROXY_MODE="external"
  else
    PROXY_MODE="bundled"
  fi
fi

if [[ "$PROXY_MODE" == "bundled" ]] && [[ "$OWN_CADDY_RUNNING" -ne 1 ]] && { port_in_use 80 || port_in_use 443; }; then
  echo "Ports 80/443 are already in use. Use --proxy-mode external or leave auto mode enabled." >&2
  exit 1
fi

if [[ "$PROXY_MODE" == "external" && "$MANAGED_OVERRIDE" -ne 1 ]] && port_in_use "$LOCAL_PORT"; then
  START_PORT="$LOCAL_PORT"
  for candidate in $(seq "$START_PORT" $((START_PORT + 20))); do
    if ! port_in_use "$candidate"; then
      LOCAL_PORT="$candidate"
      break
    fi
  done
  if port_in_use "$LOCAL_PORT"; then
    echo "Could not find a free loopback port between $START_PORT and $((START_PORT + 20))." >&2
    exit 1
  fi
fi

OPENRESTY_DETECTED=0
if ps -eo comm= 2>/dev/null | grep -qx openresty; then
  OPENRESTY_DETECTED=1
fi

echo "Reverse proxy mode: $PROXY_MODE"
if [[ "$PROXY_MODE" == "external" ]]; then
  echo "Existing web server detected; Mail Collector will listen on 127.0.0.1:$LOCAL_PORT."
fi

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
HOST=0.0.0.0
PORT=8080
DATABASE_PATH=/app/data/mail-collector.db
ENCRYPTION_KEY=$(random_hex)
API_KEY=$(random_token)
REGISTRATION_INVITE_CODE=$(random_token)
GOOGLE_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_ID=
OAUTH_REDIRECT_BASE_URL=https://${DOMAIN}/
ALLOW_PRIVATE_MAIL_HOSTS=false
SYNC_INTERVAL_MINUTES=5
INITIAL_SYNC_LIMIT=100
MAX_MESSAGE_BYTES=10485760
BODY_PREFETCH_PER_ACCOUNT=10
BODY_PREFETCH_PER_DRAIN=3
BACKFILL_PAGE_SIZE=100
RECONCILE_MESSAGE_LIMIT=500
ACTIVE_RECONCILE_MINUTES=30
NORMAL_RECONCILE_MINUTES=180
INACTIVE_RECONCILE_MINUTES=720
SYNC_LEASE_SECONDS=300
PROVIDER_MAX_ATTEMPTS=5
PROVIDER_MAX_CONCURRENCY=3
MAIL_WORKER_INTERVAL_SECONDS=2
IMAP_IDLE_ENABLED=true
IMAP_IDLE_SCAN_SECONDS=30
IMAP_IDLE_DEBOUNCE_MS=750
IMAP_IDLE_RECONNECT_MAX_SECONDS=300
EOF
else
  if grep -q '^OAUTH_REDIRECT_BASE_URL=' "$ENV_FILE"; then
    sed -i "s#^OAUTH_REDIRECT_BASE_URL=.*#OAUTH_REDIRECT_BASE_URL=https://${DOMAIN}/#" "$ENV_FILE"
  else
    printf '\nOAUTH_REDIRECT_BASE_URL=https://%s/\n' "$DOMAIN" >> "$ENV_FILE"
  fi
fi

COMPOSE_FILE="$APP_DIR/compose.yaml"
if [[ ! -f "$COMPOSE_FILE" || "$FORCE" -eq 1 ]]; then
  cat > "$COMPOSE_FILE" <<EOF
services:
  mail-collector:
    image: ${IMAGE}
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    expose:
      - "8080"
    networks:
      - mail-collector

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - mail-collector
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    networks:
      - mail-collector

networks:
  mail-collector:
    driver: bridge
EOF
fi

CADDY_FILE="$APP_DIR/Caddyfile"
if [[ ! -f "$CADDY_FILE" || "$FORCE" -eq 1 ]]; then
  {
    echo "${DOMAIN} {"
    if [[ -n "$EMAIL" ]]; then
      echo "  tls ${EMAIL}"
    fi
    echo "  encode zstd gzip"
    echo "  reverse_proxy mail-collector:8080"
    echo "}"
  } > "$CADDY_FILE"
fi

if [[ "$PROXY_MODE" == "external" ]]; then
  cat > "$OVERRIDE_FILE" <<EOF
# Managed by Mail Collector installer
services:
  mail-collector:
    ports:
      - "127.0.0.1:${LOCAL_PORT}:8080"
  caddy:
    profiles:
      - bundled-proxy
EOF
else
  if [[ "$MANAGED_OVERRIDE" -eq 1 ]]; then
    rm -f "$OVERRIDE_FILE"
  fi
fi

COMPOSE_FILES=(-f "$COMPOSE_FILE")
if [[ -f "$OVERRIDE_FILE" ]]; then
  COMPOSE_FILES+=(-f "$OVERRIDE_FILE")
fi

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

MANAGE_FILE="$APP_DIR/mailcollector"
cat > "$MANAGE_FILE" <<'MANAGE'
#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="$APP_DIR/.env"
OVERRIDE_FILE="$APP_DIR/compose.mailcollector-proxy.yaml"
COMMAND="${1:-info}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo: sudo mailcollector $COMMAND" >&2
  exit 1
fi

COMPOSE_FILES=(-f "$APP_DIR/compose.yaml")
EXTERNAL_PROXY=0
LOCAL_PORT=""
if [[ -f "$OVERRIDE_FILE" ]] && head -n1 "$OVERRIDE_FILE" | grep -Fxq "# Managed by Mail Collector installer"; then
  COMPOSE_FILES+=(-f "$OVERRIDE_FILE")
  EXTERNAL_PROXY=1
  LOCAL_PORT="$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\):8080.*/\1/p' "$OVERRIDE_FILE" | head -n1)"
fi

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

if [[ ! -f "$ENV_FILE" || ! -f "$APP_DIR/compose.yaml" ]]; then
  echo "Mail Collector installation was not found in $APP_DIR." >&2
  exit 1
fi

read_value() {
  sed -n "s/^${1}=//p" "$ENV_FILE" | head -n1
}

wait_for_service() {
  for _ in $(seq 1 30); do
    if compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

show_info() {
  local url invite version registered
  url="$(read_value OAUTH_REDIRECT_BASE_URL)"
  invite="$(read_value REGISTRATION_INVITE_CODE)"
  version="$(compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>r.json()).then(v=>console.log(v.version)).catch(()=>process.exit(1))" 2>/dev/null || echo unknown)"
  registered="$(compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/auth/status').then(r=>r.json()).then(v=>console.log(v.registered?'yes':'no')).catch(()=>process.exit(1))" 2>/dev/null || echo unknown)"

  echo
  echo "============================================================"
  echo " Mail Collector"
  echo "------------------------------------------------------------"
  echo " URL:                  $url"
  echo " Administrator invite: $invite"
  echo " Administrator exists: $registered"
  echo " Service version:      $version"
  if [[ "$EXTERNAL_PROXY" -eq 1 ]]; then
    echo " Reverse proxy target: http://127.0.0.1:$LOCAL_PORT"
  fi
  echo " Install directory:    $APP_DIR"
  echo "============================================================"
  echo
}

cd "$APP_DIR"
case "$COMMAND" in
  info)
    show_info
    ;;
  update)
    if [[ "$EXTERNAL_PROXY" -eq 1 ]]; then
      compose pull mail-collector
      compose up -d --remove-orphans mail-collector
    else
      compose pull
      compose up -d --remove-orphans
    fi
    if ! wait_for_service; then
      compose logs --tail=80 mail-collector >&2 || true
      exit 1
    fi
    show_info
    ;;
  restart)
    if [[ "$EXTERNAL_PROXY" -eq 1 ]]; then
      compose restart mail-collector
    else
      compose restart
    fi
    if ! wait_for_service; then
      compose logs --tail=80 mail-collector >&2 || true
      exit 1
    fi
    show_info
    ;;
  status)
    compose ps
    ;;
  logs)
    compose logs --tail=200 -f
    ;;
  *)
    echo "Usage: sudo mailcollector {info|update|restart|status|logs}" >&2
    exit 2
    ;;
esac
MANAGE
chmod 700 "$MANAGE_FILE"

if [[ ! -e /usr/local/bin/mailcollector || -L /usr/local/bin/mailcollector ]]; then
  ln -sfn "$MANAGE_FILE" /usr/local/bin/mailcollector
else
  echo "Warning: /usr/local/bin/mailcollector already exists; management command installed at $MANAGE_FILE." >&2
fi

cd "$APP_DIR"
if [[ "$PROXY_MODE" == "external" ]]; then
  docker compose -f "$COMPOSE_FILE" stop caddy >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" rm -f caddy >/dev/null 2>&1 || true
  compose pull mail-collector
  compose up -d --remove-orphans mail-collector
else
  compose pull
  compose up -d --remove-orphans
fi

echo "Checking Mail Collector container health..."
for _ in $(seq 1 30); do
  if compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  echo "Mail Collector did not become healthy. Recent logs:" >&2
  compose logs --tail=80 mail-collector >&2 || true
  exit 1
fi

echo
echo "Mail Collector VPS deployment is running."
"$MANAGE_FILE" info
echo "Next steps:"
if [[ "$PROXY_MODE" == "external" ]]; then
  if [[ "$OPENRESTY_DETECTED" -eq 1 ]]; then
    echo "  1. In 1Panel, create a reverse-proxy website for ${DOMAIN}."
  else
    echo "  1. In your existing web server, create an HTTPS reverse proxy for ${DOMAIN}."
  fi
  echo "  2. Set the proxy target to http://127.0.0.1:${LOCAL_PORT} and enable HTTPS."
  echo "  3. Enter https://${DOMAIN} and the invite code shown above in the Windows/Android client."
else
  echo "  1. Confirm ${DOMAIN} resolves to this VPS and TCP 80/443 are reachable."
  echo "  2. Enter https://${DOMAIN} and the invite code shown above in the Windows/Android client."
fi
echo
echo "Useful commands:"
echo "  sudo mailcollector info     Show URL and administrator invite code"
echo "  sudo mailcollector update   Pull the latest image and restart safely"
echo "  sudo mailcollector status   Show container status"
echo "  sudo mailcollector logs     Follow service logs"
