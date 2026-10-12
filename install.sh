#!/usr/bin/env bash
# Ubuntu installer. Run on YOUR VPS, not in the Replit workspace.
set -Eeuo pipefail
umask 027
DOMAIN=grinfud.reggycodas.com
DB=grinfud
ROLE=grinfud
PGPORT=5432
PORT=19138
EMAIL=
SERVER_IP=
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/app"
[[ -f "$SOURCE/server.js" ]] || SOURCE="$SCRIPT_DIR/../app"
BASE=/opt/grinfud
DATA=/var/lib/grinfud
ENV_FILE=/etc/grinfud/grinfud.env
BACKUPS=/var/backups/grinfud
SITE="/etc/nginx/sites-available/$DOMAIN"
MARKER='# Managed by the GrinFud Ubuntu installer'
usage() {
  cat <<'HELP'
sudo bash install.sh --email you@example.com [--server-ip PUBLIC_IPV4]
  --source /path/to/app   App source folder (default: app beside install.sh)
  --pg-port 5432         Existing local PostgreSQL cluster port
  --check               Read-only OS/PostgreSQL/Nginx/DNS diagnostics

Targets Ubuntu 20.04/22.04/24.04, grinfud.reggycodas.com, database/role grinfud.
PostgreSQL is NEVER installed, replaced, dropped or reset.
Existing databases must be owned by grinfud and allow local peer authentication.
Existing unrelated Nginx sites and credentials are never overwritten.
HELP
}
CHECK=0
while (($#)); do
  case "$1" in
    --email) EMAIL="${2:?Missing email}"; shift 2;;
    --server-ip) SERVER_IP="${2:?Missing IP}"; shift 2;;
    --source) SOURCE="${2:?Missing source}"; shift 2;;
    --pg-port) PGPORT="${2:?Missing port}"; shift 2;;
    --check) CHECK=1; shift;;
    --help|-h) usage; exit 0;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1;;
  esac
done
die() { echo "ERROR: $*" >&2; return 1; }
[[ "$PGPORT" =~ ^[0-9]+$ ]] && ((PGPORT > 0 && PGPORT < 65536)) || die 'Invalid PostgreSQL port.'
[[ $EUID == 0 ]] || die 'Run with sudo.'
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:20.04|ubuntu:22.04|ubuntu:24.04) ;;
  *) die 'Supported systems: Ubuntu 20.04, 22.04 and 24.04.' ;;
esac
if [[ "$VERSION_ID" == 20.04 ]]; then
  echo 'WARNING: Ubuntu 20.04 is past standard security maintenance. Use Ubuntu Pro/ESM or plan an OS upgrade. This installer will not upgrade your OS or PostgreSQL.' >&2
fi
command -v systemctl >/dev/null || die 'A systemd-based server is required.'
for tool in psql pg_dump pg_isready; do
  command -v "$tool" >/dev/null || die "PostgreSQL tool $tool is missing. Nothing will install PostgreSQL; ask your database administrator."
done
pg_isready -h /var/run/postgresql -p "$PGPORT" >/dev/null || die 'Existing PostgreSQL cluster is not ready on the selected local socket/port.'
sql() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -h /var/run/postgresql -p "$PGPORT" "$@"; }
sql -d postgres -Atqc 'SELECT 1' >/dev/null || die 'Cannot administer the existing local PostgreSQL cluster.'
echo "PostgreSQL: available on local port $PGPORT."
sql -d postgres -Atqc "SELECT datname || ' (owner: ' || pg_get_userbyid(datdba) || ')' FROM pg_database WHERE datname='grinfud'"
if command -v nginx >/dev/null; then nginx -t; fi
if command -v dig >/dev/null; then
  echo "Authoritative nameservers for reggycodas.com:"; dig +short NS reggycodas.com
  echo "Subdomain A / AAAA / CNAME records:"
  for type in A AAAA CNAME; do dig +short "$DOMAIN" "$type"; done
else echo 'DNS diagnostics need dnsutils; normal installation installs it.'; fi
if ((CHECK)); then echo 'Read-only checks complete. No changes made.'; exit 0; fi
exec 9>/run/lock/grinfud-install.lock
flock -n 9 || die 'Another GrinFud installation is running.'
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die 'Supply --email for Let’s Encrypt notices.'
[[ -f "$SOURCE/server.js" && -f "$SOURCE/photo-storage-local.js" && -f "$SOURCE/package.json" ]] || die 'Use the provided app folder, including the VPS storage adapter.'
SOURCE="$(realpath "$SOURCE")"
[[ ! -e "$SITE" ]] || grep -qFx "$MARKER" "$SITE" || die "Unmanaged Nginx site exists at $SITE; reconcile it manually first."
[[ ! -e /etc/systemd/system/grinfud.service ]] || grep -qFx "$MARKER" /etc/systemd/system/grinfud.service || die 'An unmanaged grinfud.service already exists; preserve and reconcile it first.'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends nginx certbot dnsutils curl ca-certificates openssl rsync python3 xz-utils
nginx -t
# Reject a domain already handled by another enabled virtual host.
while IFS= read -r entry; do
  [[ "$(realpath "$entry")" == "$SITE" ]] && continue
  if grep -Eq "server_name[^;]*grinfud[.]reggycodas[.]com([[:space:];]|$)" "$entry"; then
    die "Another enabled Nginx configuration handles $DOMAIN: $entry"
  fi
done < <(find -L /etc/nginx/sites-enabled /etc/nginx/conf.d -maxdepth 1 -type f 2>/dev/null)
echo 'DNS nameservers:'; dig +short NS reggycodas.com
[[ -n "$SERVER_IP" ]] || SERVER_IP="$(curl -4fsS --max-time 15 https://api.ipify.org)"
python3 - "$SERVER_IP" <<'PY'
import ipaddress, sys
assert ipaddress.ip_address(sys.argv[1]).version == 4, 'Supply a public IPv4 address.'
PY
DNS_IPS="$(dig @1.1.1.1 +short A "$DOMAIN" | grep -E '^[0-9.]+$' || true)"
[[ -n "$DNS_IPS" ]] || die "Create an A record for grinfud pointing to $SERVER_IP, then rerun."
while IFS= read -r address; do
  [[ "$address" == "$SERVER_IP" ]] || die "A record $address does not match $SERVER_IP. Disable any DNS proxy and correct the record before issuing SSL."
done <<< "$DNS_IPS"
while IFS= read -r address; do
  [[ -z "$address" ]] && continue
  ip -6 addr show scope global | grep -Fq "$address/" || die "AAAA record $address is not assigned to this server. Correct/remove the AAAA record before issuing SSL."
done < <(dig @1.1.1.1 +short AAAA "$DOMAIN" | grep ':' || true)
echo "DNS points to this server. TCP ports 80 and 443 must be open in your firewall/provider."

EXISTS="$(sql -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='grinfud'")"
if [[ "$EXISTS" == 1 ]]; then
  OWNER="$(sql -d postgres -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='grinfud'")"
  [[ "$OWNER" == "$ROLE" ]] || die "Existing grinfud database belongs to $OWNER. No ownership changes made. Have your DBA configure a compatible grinfud role/database before rerunning."
  if [[ "$(sql -d "$DB" -Atqc "SELECT to_regclass('public.items') IS NULL AND to_regclass('grinfud_demo.items') IS NOT NULL")" == t ]]; then
    die 'Only the demo schema exists. Explicitly migrate the intended data to public first; the installer will not create a competing empty catalog.'
  fi
fi
if id "$ROLE" >/dev/null 2>&1; then
  [[ "$(id -u "$ROLE")" -lt 1000 && "$(id -u "$ROLE")" -gt 0 ]] || die 'Existing grinfud OS account is not a system service account; refusing to reuse it.'
else useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin "$ROLE"; fi
install -d -o "$ROLE" -g "$ROLE" -m 750 "$DATA" "$DATA/uploads"
install -d -o root -g "$ROLE" -m 750 "$BASE/releases"
install -d -m 750 /etc/grinfud
install -d -m 700 "$BACKUPS"
if [[ -z "$(sql -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname='grinfud'")" ]]; then
  sql -d postgres -c 'CREATE ROLE grinfud LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
fi
[[ "$(sql -d postgres -Atqc "SELECT rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname='grinfud'")" == f ]] || die 'grinfud must be a least-privilege database role, not an administrator.'
if [[ "$EXISTS" != 1 ]]; then
  sql -d postgres -c 'CREATE DATABASE grinfud OWNER grinfud'
else echo 'Reusing the existing grinfud database.'; fi
runuser -u "$ROLE" -- psql -X -h /var/run/postgresql -p "$PGPORT" -d "$DB" -Atqc 'SELECT 1' >/dev/null ||
  die 'Local peer authentication for grinfud failed. No pg_hba.conf changes were made; ask your DBA to configure this connection.'

# Existing keys must be retained: SESSION_SECRET encrypts the admin-entered API keys.
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ "$(sql -d "$DB" -Atqc "SELECT to_regclass('public.provider_credentials') IS NOT NULL")" == t ]]; then
    [[ "$(sql -d "$DB" -Atqc "SELECT count(*) FROM provider_credentials WHERE encrypted_value<>''")" == 0 ]] ||
      die "Existing encrypted provider keys require the original SESSION_SECRET. Securely restore $ENV_FILE before continuing."
  fi
  read -rsp 'New admin password (at least 16 characters, not shown): ' ADMIN </dev/tty; echo
  read -rsp 'Confirm admin password: ' CONFIRM </dev/tty; echo
  [[ "$ADMIN" == "$CONFIRM" && ${#ADMIN} -ge 16 ]] || die 'Passwords must match and contain at least 16 characters.'
  # Restrict only characters that cannot be represented safely in EnvironmentFile.
  [[ "$ADMIN" != *$'\n'* && "$ADMIN" != *'"'* && "$ADMIN" != *'\'* ]] || die 'Password must not contain newlines, double quotes or backslashes.'
  SECRET="$(openssl rand -hex 48)"
  (umask 077; printf 'ADMIN_PASSWORD="%s"\nSESSION_SECRET=%s\n' "$ADMIN" "$SECRET" > "$ENV_FILE")
  unset ADMIN CONFIRM SECRET
else echo 'Preserving existing admin password and SESSION_SECRET.'; fi
chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"
grep -q '^ADMIN_PASSWORD=' "$ENV_FILE" && grep -q '^SESSION_SECRET=' "$ENV_FILE" || die 'Environment file must define ADMIN_PASSWORD and SESSION_SECRET.'
if grep -Eq '^[[:space:]]*(DATABASE_URL|DATA_DIR|PHOTO_STORAGE|HOST|PORT|PUBLIC_URL|NODE_ENV)=' "$ENV_FILE"; then
  die 'Keep only secrets/provider credentials in the environment file; the installer owns database, storage and host configuration.'
fi

# Install a private Node 22 runtime, never replace the server's global Node.
if [[ ! -x "$BASE/node/bin/node" ]]; then
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64) ARCH=arm64;; *) die 'Unsupported CPU architecture.';; esac
  TMP="$(mktemp -d)"
  curl -fsS --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$TMP/SHASUMS256.txt"
  ARCHIVE="$(awk -v arch="$ARCH" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$TMP/SHASUMS256.txt")"
  [[ "$ARCHIVE" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || die 'Could not identify the official Node archive.'
  curl -fsS --retry 3 "https://nodejs.org/dist/latest-v22.x/$ARCHIVE" -o "$TMP/$ARCHIVE"
  (cd "$TMP"; grep " $ARCHIVE\$" SHASUMS256.txt | sha256sum -c -)
  install -d "$BASE/node"
  tar -xJf "$TMP/$ARCHIVE" -C "$BASE/node" --strip-components=1
  rm -rf "$TMP"
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RELEASE="$BASE/releases/$STAMP"
install -d -o "$ROLE" -g "$ROLE" "$RELEASE"
rsync -a --exclude='node_modules' --exclude='.env*' --exclude='data' --exclude='data-demo' --exclude='*.log' "$SOURCE/" "$RELEASE/"
chown -R "$ROLE:$ROLE" "$RELEASE"
if [[ -f "$RELEASE/package-lock.json" ]]; then NPM_ACTION=ci; else NPM_ACTION=install; fi
runuser -u "$ROLE" -- env PATH="$BASE/node/bin:/usr/bin:/bin" \
  npm --prefix "$RELEASE" "$NPM_ACTION" --omit=dev --no-audit --no-fund
chown -R root:"$ROLE" "$RELEASE"
chmod -R go-w "$RELEASE"

WAS_RUNNING=0
systemctl is-active --quiet grinfud.service && WAS_RUNNING=1
OLD_RELEASE="$(readlink -f "$BASE/current" 2>/dev/null || true)"
OLD_SITE=
[[ ! -f "$SITE" ]] || { OLD_SITE="$BACKUPS/nginx-$STAMP.conf"; cp -a "$SITE" "$OLD_SITE"; }
cleanup_failure() {
  local status=$?
  trap - ERR
  echo 'Installation stopped. Database backup and prior release are retained; no automatic database restore is attempted.' >&2
  if [[ -n "$OLD_RELEASE" && -d "$OLD_RELEASE" ]]; then
    ln -sfn "$OLD_RELEASE" "$BASE/current"
    ((WAS_RUNNING == 0)) || systemctl restart grinfud.service || true
  fi
  if [[ -n "$OLD_SITE" ]]; then cp -a "$OLD_SITE" "$SITE"; nginx -t && systemctl reload nginx || true; fi
  exit "$status"
}
trap cleanup_failure ERR
if ((WAS_RUNNING)); then systemctl stop grinfud.service; fi
runuser -u postgres -- pg_dump -h /var/run/postgresql -p "$PGPORT" -Fc "$DB" > "$BACKUPS/database-$STAMP.dump"
[[ -s "$BACKUPS/database-$STAMP.dump" ]]
cp -a "$ENV_FILE" "$BACKUPS/environment-$STAMP"
tar -czf "$BACKUPS/uploads-$STAMP.tar.gz" -C "$DATA" uploads
chmod 600 "$BACKUPS/"*"$STAMP"*
echo "Pre-migration database, uploads and credential backups: $BACKUPS (root only)."

# A one-shot unit loads secrets securely; they never appear as command-line arguments.
cat > /etc/systemd/system/grinfud-migrate.service <<EOF
$MARKER
[Unit]
Description=GrinFud additive database migrations
After=postgresql.service
[Service]
Type=oneshot
User=$ROLE
Group=$ROLE
WorkingDirectory=$RELEASE
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
Environment=PHOTO_STORAGE=local
Environment=DATA_DIR=$DATA
Environment=DATABASE_URL=postgresql://grinfud@localhost/grinfud?host=/var/run/postgresql&port=$PGPORT
ExecStart=$BASE/node/bin/node $RELEASE/server.js --migrate-only
TimeoutStartSec=300
UMask=0027
EOF
systemctl daemon-reload
systemctl start grinfud-migrate.service
if [[ "$EXISTS" != 1 ]]; then
  # Fresh installations must not notify the old sample kitchen number.
  sql -d "$DB" -c "UPDATE settings SET value='' WHERE key='notify_phone'; UPDATE settings SET value='0' WHERE key IN ('notify_customer','whatsapp_chat_enabled');"
fi
ln -sfn "$RELEASE" "$BASE/current"
cat > /etc/systemd/system/grinfud.service <<EOF
$MARKER
[Unit]
Description=GrinFud Orders
After=network.target postgresql.service
[Service]
Type=simple
User=$ROLE
Group=$ROLE
WorkingDirectory=$BASE/current
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=PHOTO_STORAGE=local
Environment=DATA_DIR=$DATA
Environment=PUBLIC_URL=https://$DOMAIN
Environment=DATABASE_URL=postgresql://grinfud@localhost/grinfud?host=/var/run/postgresql&port=$PGPORT
ExecStart=$BASE/node/bin/node $BASE/current/server.js
Restart=on-failure
RestartSec=5
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable grinfud.service
systemctl restart grinfud.service
READY=0
for attempt in {1..30}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/menu" >/dev/null; then READY=1; break; fi
  sleep 2
done
[[ "$READY" == 1 ]] || die 'App did not become healthy; inspect journalctl -u grinfud.'
install -d -m 755 /var/www/grinfud-acme
write_site() {
  local tls="$1"
  {
    echo "$MARKER"
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root /var/www/grinfud-acme; }
EOF
    if [[ "$tls" != yes ]]; then
      printf '    location / { return 503; }\n}\n'
      return
    fi
    if [[ "$tls" == yes ]]; then
      cat <<EOF
    location / { return 301 https://$DOMAIN\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
EOF
    fi
    cat <<EOF
    client_max_body_size 26m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 90s;
        proxy_buffering off;
    }
}
EOF
  } > "$SITE"
}
if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" && -f "/etc/letsencrypt/live/$DOMAIN/privkey.pem" ]]; then
  write_site yes
else write_site no; fi
ln -sfn "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t
systemctl enable --now nginx
systemctl reload nginx
certbot certonly --webroot -w /var/www/grinfud-acme -d "$DOMAIN" \
  --cert-name "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive --keep-until-expiring
write_site yes
nginx -t
systemctl reload nginx
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nnginx -t && systemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/grinfud-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/grinfud-nginx
systemctl enable --now certbot.timer
curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/menu" >/dev/null
trap - ERR
echo "Installed: https://$DOMAIN"
echo "Admin: https://$DOMAIN/admin (use the password you entered; never the demo password)."
echo 'Review admin settings and re-enter provider keys if this is a fresh install. No payment prompt or message was sent.'
echo 'Back up /var/lib/grinfud, /etc/grinfud/grinfud.env and the database regularly.'
