# GrinFud on Ubuntu

This bundle contains the current application and `install.sh`. It targets
**Ubuntu 20.04, 22.04 or 24.04**, `grinfud.luxestores.shop`, and the local PostgreSQL
database **grinfud**. Run it on your VPS, not inside Replit.

Ubuntu 20.04 is past standard security maintenance. Keep security updates active
through Ubuntu Pro/ESM or plan an upgrade to a newer LTS. The installer does not
upgrade the OS or PostgreSQL. It uses the same private Node 22 runtime and
systemd/Nginx configuration on all three versions.

## Before running

1. Back up your server. The installer also makes a database dump, uploads archive
   and credentials copy before application migrations, in `/var/backups/grinfud`.
2. PostgreSQL must already be installed and running. The script **never installs
   or upgrades PostgreSQL** and never edits `pg_hba.conf`.
3. The existing `grinfud` database must be owned by a non-superuser login role
   named `grinfud`. Local Unix-socket peer authentication must work for the
   `grinfud` system user. If ownership differs, the installer stops: have your
   DBA review table ownership/authentication, rather than automatically changing it.
   If the role/database does not exist, the installer creates it once.
4. Point DNS **A record `grinfud`** at the VPS public IPv4 address. Correct or
   remove any AAAA record that points elsewhere. Temporarily disable Cloudflare
   or other DNS proxying for certificate issuance. DNS can take time to propagate.
   Nameservers belong to your domain/DNS provider, not Nginx; the script reports
   them but does not change them.
5. Allow inbound TCP **80 and 443** through your VPS/provider firewall. The
   installer deliberately does not change firewall rules or expose PostgreSQL.
6. Supply your email address for Let's Encrypt expiry notices and terms acceptance.

## Run

From GitHub on your VPS:

```bash
git clone https://github.com/freddysundowner/grinfud.git
cd grinfud
sudo bash install.sh --check
sudo bash install.sh --email YOUR_EMAIL --server-ip YOUR_VPS_IPV4
```

For later updates, run `git pull --ff-only` in this checkout and rerun the
installer. Keep server credentials and uploads outside the checkout.

Extract the archive, enter its directory, then:

```bash
sudo bash install.sh --check
sudo bash install.sh --email YOUR_EMAIL --server-ip YOUR_VPS_IPV4
```

Replace the uppercase placeholders. `--check` performs read-only checks; it may
report that dnsutils is missing. The real installation installs DNS tools.
You can omit `--server-ip` to detect IPv4 through ipify.
Use `--pg-port 5433` if your intended PostgreSQL cluster uses another port.

The first installation prompts privately in your terminal for an admin password.
It creates a persistent session/encryption secret and saves both in
`/etc/grinfud/grinfud.env`, readable only by root. Reruns preserve that file.
Do not send these values in chat or include them in Git.

The script installs Nginx, Certbot and supporting Ubuntu packages as necessary;
downloads an official Node 22 runtime with SHA-256 verification into
`/opt/grinfud/node` without replacing your system Node; installs application
dependencies; backs up data; runs additive initialization/migrations; starts
a dedicated systemd service; obtains SSL; configures HTTP-to-HTTPS redirection;
and enables the Certbot renewal timer with an Nginx reload hook.

An HTTP-only first installation serves a maintenance response until SSL succeeds.
Existing unrelated virtual hosts are left alone. Conflicting configurations stop
the installation. The application only binds to `127.0.0.1:19138`.

## Existing data and photos

**This is a code bundle, not a database or credentials export.** It does not copy
the Replit database, demo orders, uploaded photos or API keys automatically.
Your existing VPS `grinfud` database is reused. No `DROP`, `TRUNCATE`, table reset,
replacement database, or destructive data migration is performed.
Initialization adds missing tables/columns/indexes, fills missing defaults,
backfills customer/tracking information and adds one starter product only if
the item table is empty. Existing menu items, orders and settings are retained.
No message or payment request is sent by migration.

Before bringing an existing installation over:

- Securely transfer the intended database data, with explicit review of schema
  names and ownership. Production uses `public`; Replit demo data lives in
  `grinfud_demo`. The installer stops if only the demo catalog is detected.
  It does not silently turn demo data into production.
- Copy the uploaded photo bytes into `/var/lib/grinfud/uploads`, retaining
  their exact filenames; make them readable by the `grinfud` service account.
  Existing `/uploads/...` URLs remain unchanged. Replit App Storage cannot
  authenticate from a VPS; this bundle explicitly uses disk storage instead.
  Do not delete the original storage objects until copied files are verified.
- If encrypted API credentials already exist in the database, securely restore
  the **original SESSION_SECRET** together with `ADMIN_PASSWORD` to
  `/etc/grinfud/grinfud.env` before rerunning. Otherwise the installer stops.
  Losing that secret means saved provider keys cannot be decrypted.
  This file is for secrets only, not DATABASE_URL, DATA_DIR, PORT, HOST,
  PHOTO_STORAGE, PUBLIC_URL or NODE_ENV; the installer controls those settings.
- Current development photos and data are not altered by preparing this bundle.

Database backups are sensitive. They and the credentials backups are root-only.
Retain an off-server encrypted backup of the database, uploads and secret file.
Installer backups are point-in-time copies, **not** an ongoing backup schedule.

## After installation

Open `https://grinfud.luxestores.shop/admin` with the password you entered.
Review delivery settings, kitchen notification number, chat channels and provider
keys before accepting orders. Fresh databases start without a kitchen contact.
Existing settings are retained. SunPay is real-money functionality and must only
be enabled intentionally in admin.

```bash
sudo systemctl status grinfud nginx certbot.timer
sudo journalctl -u grinfud -n 100 --no-pager
sudo journalctl -u grinfud-migrate -n 100 --no-pager
sudo nginx -t
sudo certbot renew --dry-run
```

Run the same installer from a newer bundle to update. Prior application releases
are retained under `/opt/grinfud/releases`; no uploads directory is overwritten.
The script stops the managed app during the backup/migration window. Other
writers must also be stopped separately if they share this database.
On a failure after migration begins it attempts to restore the previous app
symlink/service and managed Nginx configuration. It **never restores a database
automatically**, because that could destroy newer data; partial additive schema
changes are left in place and are safe to rerun. Inspect the reported error and
backups before retrying. Repeated installations do not rotate secrets or recreate
an existing database.

## Verification limits

Local storage behavior, repeated migrations and shell syntax can be checked in
the development environment. Actual Ubuntu package installation, your database
permissions, public DNS reachability, Nginx configuration and certificate issuance
must be verified on your server. The installer performs these checks and exits on
failure; this bundle does not claim that your domain is already live.
