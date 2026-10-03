#!/usr/bin/env bash
# OpenWar release deploy (run ON the VPS as root).
#
#   sudo /opt/openwar/deploy/deploy.sh /path/to/openwar-release-<version>.tgz
#
# The archive is unpacked into /opt/openwar/releases/<utc-stamp>-<sha12>, production
# dependencies are installed from package-lock.json (npm ci --omit=dev), the
# /opt/openwar/current symlink is flipped atomically, openwar-backend is restarted and
# the health probe must pass - otherwise the previous release is restored.
#
# Expected archive layout (top-level dir optional): package.json, package-lock.json,
# server/index.js, src/**, dist/** (built client; served at https://<ip>/ ).
set -euo pipefail

APP_ROOT=/opt/openwar
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
UNIT=openwar-backend.service
KEEP=5

[ "$(id -u)" -eq 0 ] || { echo "deploy.sh: must run as root" >&2; exit 1; }
TARBALL=${1:?usage: deploy.sh <release.tgz>}
[ -f "$TARBALL" ] || { echo "deploy.sh: no such file: $TARBALL" >&2; exit 1; }

sha=$(sha256sum "$TARBALL" | cut -c1-12)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
new="$RELEASES/$stamp-$sha"
stage=$(mktemp -d /tmp/openwar-deploy.XXXXXX)
trap 'rm -rf "$stage"' EXIT

echo "==> extracting $TARBALL (sha256:$sha)"
tar -xzf "$TARBALL" -C "$stage"
# unwrap a single top-level directory if the archive has one
inner=$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)
if [ -n "$inner" ] && [ "$(find "$stage" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then
  appdir=$inner
else
  appdir=$stage
fi
# tolerate packaging extras (README, .gitignore, ...) next to the app directory
if [ ! -f "$appdir/package.json" ]; then
  cand=$(find "$stage" -mindepth 1 -maxdepth 2 -name package.json -printf '%h\n' | head -1)
  if [ -n "$cand" ] && [ -f "$cand/server/index.js" ]; then appdir=$cand; fi
fi

[ -f "$appdir/package.json" ] || { echo "deploy.sh: package.json missing in archive" >&2; exit 1; }
[ -f "$appdir/server/index.js" ] || { echo "deploy.sh: server/index.js missing in archive" >&2; exit 1; }

mkdir -p "$RELEASES"
rm -rf "$new"; mkdir -p "$new"
cp -a "$appdir/." "$new/"

echo "==> installing production dependencies"
cd "$new"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

if [ -f "$new/dist/index.html" ]; then
  echo "==> built client found: dist/index.html ($(du -sh "$new/dist" | cut -f1))"
else
  echo "==> WARNING: no dist/index.html in this release - the public page falls back to the backend message"
fi

# immutable, root-owned code: owner rw, everyone else read-only (no group/other write)
chown -R root:root "$new"
chmod -R u=rwX,go=rX "$new"

prev=""
if [ -L "$CURRENT" ]; then prev=$(readlink -f "$CURRENT"); fi

echo "==> activating $new"
ln -sfn "$new" "$APP_ROOT/current.new"
mv -T "$APP_ROOT/current.new" "$CURRENT"

echo "==> restarting $UNIT"
systemctl restart "$UNIT"
for i in $(seq 1 20); do
  systemctl is-active --quiet "$UNIT" && break
  sleep 0.5
done

# the process is "active" before it has finished importing its module graph and bound the
# port, so give the health probe a few attempts before calling the release bad
ok=0
for attempt in 1 2 3 4 5; do
  if systemctl is-active --quiet "$UNIT" && "$APP_ROOT/deploy/healthcheck.sh"; then ok=1; break; fi
  echo "==> health check attempt $attempt failed; retrying in 2s" >&2
  sleep 2
done

if [ "$ok" -eq 1 ]; then
  echo "==> deploy OK: $new"
  systemctl start openwar-healthcheck.timer
else
  echo "==> health check FAILED - rolling back" >&2
  systemctl status "$UNIT" --no-pager -l | tail -20 >&2 || true
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    ln -sfn "$prev" "$APP_ROOT/current.new"; mv -T "$APP_ROOT/current.new" "$CURRENT"
    systemctl restart "$UNIT"
    echo "==> rolled back to $prev" >&2
  else
    echo "==> no previous release to roll back to - returning to the empty state" >&2
    rm -f "$CURRENT"
    systemctl stop "$UNIT" || true
  fi
  exit 1
fi

# prune old releases (never touches the active one)
cd "$RELEASES"
ls -1dt -- */ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  old=${old%/}
  [ "$RELEASES/$old" = "$(readlink -f "$CURRENT")" ] && continue
  echo "==> pruning $old"
  rm -rf -- "$RELEASES/$old"
done

echo "==> active release: $(readlink -f "$CURRENT")"
