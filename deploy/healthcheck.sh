#!/bin/sh
# OpenWar health probe (infrastructure-owned). Exits non-zero when the public entry point,
# the loopback backend or the WebSocket upgrade path is broken.
# Run by openwar-healthcheck.timer; output lands in the journal.
#
# The HTTP checks accept any 2xx-4xx response: that proves nginx and the backend answer
# (a release without a built client answers 404 here - deploy.sh reports that separately).
# 5xx, a refused connection or a failed TLS verification is a real failure. The strict
# functional gate is check 3: a real RFC6455 upgrade through the public endpoint.
set -u
fail=0

probe() { # probe <label> <url>
  code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$2" || true)
  case "$code" in
    2*|3*|4*) echo "ok:   $1 -> HTTP $code" ;;
    *)        echo "FAIL: $1 -> HTTP $code"; fail=1 ;;
  esac
}

# 1. Public HTTPS entry point (certificate is verified, hairpin through the public IP).
probe "https://130.162.162.132/healthz" "https://130.162.162.132/healthz"

# 2. Backend directly on the loopback interface.
probe "http://127.0.0.1:8080/" "http://127.0.0.1:8080/"

# 3. WebSocket upgrade through nginx (the path browsers use) - also checks the origin contract.
if ! /usr/bin/node /opt/openwar/deploy/wscheck.mjs; then
  echo "FAIL: wss://130.162.162.132/ws upgrade"; fail=1
fi

[ "$fail" -eq 0 ] && echo "openwar health: OK"
exit "$fail"
