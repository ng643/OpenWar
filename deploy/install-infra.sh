#!/usr/bin/env bash
# OpenWar infrastructure installer (run ON the VPS as root, from the directory holding
# the deploy/ files). Idempotent: safe to re-run after editing any file here.
#
#   sudo /opt/openwar/deploy/install-infra.sh
#
# Installs: /opt/openwar layout, openwar service account, nginx site, systemd units
# (openwar-backend, certbot-renew, openwar-healthcheck). Application code is NOT
# installed here - use deploy.sh with a release archive.
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
APP_ROOT=/opt/openwar
ACME_ROOT=/var/www/openwar-acme

[ "$(id -u)" -eq 0 ] || { echo "install-infra.sh: must run as root" >&2; exit 1; }

echo "==> directories"
mkdir -p "$APP_ROOT"/{releases,shared,deploy} "$ACME_ROOT/.well-known/acme-challenge"
chmod 755 "$APP_ROOT" "$APP_ROOT"/releases "$APP_ROOT"/shared "$ACME_ROOT" "$ACME_ROOT/.well-known" "$ACME_ROOT/.well-known/acme-challenge"
chown -R root:root "$APP_ROOT" "$ACME_ROOT"

echo "==> service account"
if ! id -u openwar >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_ROOT" --shell /usr/sbin/nologin openwar
fi
chown openwar:openwar "$APP_ROOT/shared"
chmod 750 "$APP_ROOT/shared"

echo "==> deploy files"
# keep a full copy of the config set in $APP_ROOT/deploy so this installer can be
# re-run from there (recovery without re-uploading); it is the source when SRC==there
if [ "$SRC" != "$APP_ROOT/deploy" ]; then
  for f in "$SRC"/*.sh "$SRC"/*.mjs "$SRC"/*.conf "$SRC"/*.service "$SRC"/*.timer; do
    if [ -f "$f" ]; then install -m 0644 -o root -g root "$f" "$APP_ROOT/deploy/$(basename "$f")"; fi
  done
fi
chmod 0755 "$APP_ROOT/deploy"/*.sh
chmod 0644 "$APP_ROOT/deploy"/*.mjs "$APP_ROOT/deploy"/*.conf "$APP_ROOT/deploy"/*.service "$APP_ROOT/deploy"/*.timer

echo "==> nginx site"
# The TLS site needs /etc/letsencrypt/live/130.162.162.132/fullchain.pem; on a fresh box
# install the HTTP/ACME bootstrap site first, run certbot, then re-run this script.
if [ -s /etc/letsencrypt/live/130.162.162.132/fullchain.pem ]; then
  install -m 0644 -o root -g root "$SRC/nginx-openwar.conf" /etc/nginx/sites-available/openwar
else
  echo "    WARNING: no certificate yet - installing HTTP/ACME bootstrap site" >&2
  install -m 0644 -o root -g root "$SRC/nginx-openwar-http.conf" /etc/nginx/sites-available/openwar
fi
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/openwar /etc/nginx/sites-enabled/openwar
nginx -t

echo "==> systemd units"
install -m 0644 -o root -g root "$SRC/openwar-backend.service"   /etc/systemd/system/openwar-backend.service
install -m 0644 -o root -g root "$SRC/certbot-renew.service"     /etc/systemd/system/certbot-renew.service
install -m 0644 -o root -g root "$SRC/certbot-renew.timer"       /etc/systemd/system/certbot-renew.timer
install -m 0644 -o root -g root "$SRC/openwar-healthcheck.service" /etc/systemd/system/openwar-healthcheck.service
install -m 0644 -o root -g root "$SRC/openwar-healthcheck.timer"   /etc/systemd/system/openwar-healthcheck.timer
systemctl daemon-reload
systemctl enable openwar-backend.service certbot-renew.timer openwar-healthcheck.timer
# renewal is independent of the app; the healthcheck timer may run from boot - the
# service itself is skipped (ConditionPathExists) while no release is deployed.
systemctl start certbot-renew.timer openwar-healthcheck.timer
systemctl reload nginx

echo "==> done"
echo "    backend unit is enabled but not started until a release exists:"
echo "      sudo $APP_ROOT/deploy/deploy.sh <release.tgz>"
