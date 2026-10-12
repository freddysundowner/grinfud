#!/usr/bin/env bash
# Run after install.sh on the VPS. Never sources or prints credentials.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
PGPORT="${1:-5432}"
[[ "$PGPORT" =~ ^[0-9]+$ ]] && ((PGPORT > 0 && PGPORT < 65536)) || { echo 'Invalid PostgreSQL port.' >&2; exit 1; }
APP=/opt/grinfud/current
[[ -f "$APP/dev/seed-menu.js" && -x /opt/grinfud/node/bin/node ]] || {
  echo 'Run the latest install.sh first to install the sample-menu command.' >&2; exit 1;
}
echo 'This adds 3 visible sample menu items with photos; it does not add customers or orders.'
read -rp 'Type SEED to continue: ' ANSWER </dev/tty
[[ "$ANSWER" == SEED ]] || { echo 'No changes made.'; exit 0; }
exec 9>/run/lock/grinfud-install.lock
flock -n 9 || { echo 'Installation or seeding is already running.' >&2; exit 1; }
runuser -u grinfud -- env \
  PHOTO_STORAGE=local DATA_DIR=/var/lib/grinfud \
  DATABASE_URL="postgresql://grinfud@localhost/grinfud?host=/var/run/postgresql&port=$PGPORT" \
  /opt/grinfud/node/bin/node "$APP/dev/seed-menu.js" --confirm
