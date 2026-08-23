#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${MAIL_COLLECTOR_DIR:-/opt/mail-collector}"
IMAGE="${MAIL_COLLECTOR_IMAGE:-ghcr.io/arronhc/mailcollector:latest}"
DOMAIN="${MAIL_COLLECTOR_DOMAIN:-}"
EMAIL="${MAIL_COLLECTOR_ACME_EMAIL:-}"
FORCE=0

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

MANAGE_FILE="$APP_DIR/mailcollector"
cat > "$MANAGE_FILE" <<'MANAGE'
#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="$APP_DIR/.env"
COMMAND="${1:-info}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo: sudo mailcollector $COMMAND" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" || ! -f "$APP_DIR/compose.yaml" ]]; then
  echo "Mail Collector installation was not found in $APP_DIR." >&2
  exit 1
fi

read_value() {
  sed -n "s/^${1}=//p" "$ENV_FILE" | head -n1
}

wait_for_service() {
  for _ in $(seq 1 30); do
    if docker compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
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
  version="$(docker compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>r.json()).then(v=>console.log(v.version)).catch(()=>process.exit(1))" 2>/dev/null || echo unknown)"
  registered="$(docker compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/auth/status').then(r=>r.json()).then(v=>console.log(v.registered?'yes':'no')).catch(()=>process.exit(1))" 2>/dev/null || echo unknown)"

  echo
  echo "============================================================"
  echo " Mail Collector"
  echo "------------------------------------------------------------"
  echo " URL:                  $url"
  echo " Administrator invite: $invite"
  echo " Administrator exists: $registered"
  echo " Service version:      $version"
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
    docker compose pull
    docker compose up -d --remove-orphans
    if ! wait_for_service; then
      docker compose logs --tail=80 mail-collector >&2 || true
      exit 1
    fi
    show_info
    ;;
  restart)
    docker compose restart
    if ! wait_for_service; then
      docker compose logs --tail=80 mail-collector >&2 || true
      exit 1
    fi
    show_info
    ;;
  status)
    docker compose ps
    ;;
  logs)
    exec docker compose logs --tail=200 -f
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
docker compose pull
docker compose up -d --remove-orphans

echo "Checking Mail Collector container health..."
for _ in $(seq 1 30); do
  if docker compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker compose exec -T mail-collector node -e "fetch('http://127.0.0.1:8080/api/service').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  echo "Mail Collector did not become healthy. Recent logs:" >&2
  docker compose logs --tail=80 mail-collector >&2 || true
  exit 1
fi

echo
echo "Mail Collector VPS deployment is running."
"$MANAGE_FILE" info
echo "Next steps:"
echo "  1. Confirm ${DOMAIN} resolves to this VPS and TCP 80/443 are reachable."
echo "  2. Enter https://${DOMAIN} and the invite code shown above in the Windows/Android client."
echo
echo "Useful commands:"
echo "  sudo mailcollector info     Show URL and administrator invite code"
echo "  sudo mailcollector update   Pull the latest image and restart safely"
echo "  sudo mailcollector status   Show container status"
echo "  sudo mailcollector logs     Follow service logs"
