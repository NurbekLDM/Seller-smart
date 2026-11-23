#!/bin/sh
#
# One-time server setup: self-hosted Supabase + the SmartSeller app behind
# Caddy (HTTPS) on one domain. Debian/Ubuntu or RHEL-family Linux.
#
#   git clone <this repo> /opt/smartseller/app
#   sudo sh /opt/smartseller/app/deploy/install.sh \
#        --domain sellersmart.uz --email admin@sellersmart.uz
#
# Options:
#   --domain <host>        domain whose A record points at this server (required)
#   --email <address>      contact for the Let's Encrypt certificate (required)
#   --staff-domain <host>  e-mail domain behind staff usernames
#                          (default staff.sellersmart.uz, must match the cloud's)
#   --supabase-ref <ref>   self-hosted Supabase release to install
#                          (default: the latest self-hosted/v* tag)
#   --no-start             configure everything but do not start the stack
#
# Safe to re-run: an existing Supabase project and its secrets are kept;
# only the SmartSeller settings in its .env are rewritten.

set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
BASE=${SMARTSELLER_BASE:-/opt/smartseller}
SUPA_DIR="$BASE/supabase"
DOMAIN=""
EMAIL=""
STAFF_DOMAIN="staff.sellersmart.uz"
SUPA_REF=""
START=1

log()  { printf '===> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --staff-domain) STAFF_DOMAIN="$2"; shift 2 ;;
        --supabase-ref) SUPA_REF="$2"; shift 2 ;;
        --no-start) START=0; shift ;;
        -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
done

[ -n "$DOMAIN" ] || die "--domain is required"
[ -n "$EMAIL" ] || die "--email is required"
case "$DOMAIN" in
    http://*|https://*|*/*) die "--domain takes a bare host name, e.g. sellersmart.uz" ;;
esac
[ "$(id -u)" = "0" ] || die "Run as root (sudo sh $0 ...)"

# --------------------------------------------------------------- memory --

mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
swap_kb=$(awk '/SwapTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$mem_kb" -lt 3500000 ] && [ "$swap_kb" -lt 1000000 ] && [ ! -e /swapfile ]; then
    log "Less than 4 GB RAM and no swap: adding a 4 GB swap file"
    fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# -------------------------------------------------------------- supabase --

mkdir -p "$BASE"
if [ -f "$SUPA_DIR/.env" ] && [ -f "$SUPA_DIR/docker-compose.yml" ]; then
    log "Supabase project already present at $SUPA_DIR; keeping its secrets"
else
    log "Installing self-hosted Supabase into $SUPA_DIR (Docker is installed if missing)"
    command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -qq -y curl; } 2>/dev/null || dnf install -q -y curl
    setup_script=$(mktemp)
    curl -fsSL https://raw.githubusercontent.com/supabase/supabase/master/docker/setup.sh -o "$setup_script"
    ( cd "$BASE" && if [ -n "$SUPA_REF" ]; then
          sh "$setup_script" -y --project-dir supabase --ref "$SUPA_REF"
      else
          sh "$setup_script" -y --project-dir supabase
      fi )
    rm -f "$setup_script"
fi

cd "$SUPA_DIR"

# Replace KEY=... in .env, or append it.
set_env() {
    if grep -q "^$1=" .env; then
        # | as the sed delimiter: values are URLs and paths, never contain it.
        sed -i "s|^$1=.*$|$1=$2|" .env
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
}

log "Writing SmartSeller settings into $SUPA_DIR/.env"
set_env SUPABASE_PUBLIC_URL "https://$DOMAIN"
set_env API_EXTERNAL_URL "https://$DOMAIN/auth/v1"
set_env SITE_URL "https://$DOMAIN"
set_env PROXY_DOMAIN "$DOMAIN"
# Accounts are created only by the owner/admin (the /admin page and the
# ERP Employees screen, both with email_confirm), never by self sign-up.
set_env DISABLE_SIGNUP true
set_env ENABLE_EMAIL_SIGNUP true
set_env ENABLE_EMAIL_AUTOCONFIRM true
set_env ENABLE_PHONE_SIGNUP false
set_env ENABLE_PHONE_AUTOCONFIRM false
set_env ENABLE_ANONYMOUS_USERS false
set_env APP_DOMAIN "$DOMAIN"
set_env ACME_EMAIL "$EMAIL"
set_env SMARTSELLER_APP_DIR "$APP_DIR"
set_env STAFF_EMAIL_DOMAIN "$STAFF_DOMAIN"
chmod 600 .env

ln -sf "$APP_DIR/deploy/docker-compose.smartseller.yml" docker-compose.smartseller.yml
case "$(grep '^COMPOSE_FILE=' .env | cut -d= -f2-)" in
    *docker-compose.smartseller.yml*) ;;
    *) sh run.sh config add smartseller ;;
esac

if [ "$START" = "1" ]; then
    log "Pulling images and starting the stack (first start takes a few minutes)"
    sh run.sh pull
    sh run.sh start
fi

cat <<EOF

Done.

  App + API:      https://$DOMAIN
  Supabase dir:   $SUPA_DIR   (secrets in .env — back it up, keep it private)
  App checkout:   $APP_DIR

  Studio (database dashboard) is not on the internet. Open it through SSH:
      ssh -L 8000:127.0.0.1:8000 <user>@<server>
      then http://localhost:8000  (login: DASHBOARD_USERNAME / DASHBOARD_PASSWORD
      from "sh $SUPA_DIR/run.sh secrets")

  Next: move the data from Supabase cloud — see deploy/SERVER.md, step 3.
EOF
