#!/bin/bash
# Smoke-test a built folder (ops/build.sh) before it goes live: start its server on a throwaway
# database, home folder and loopback port, then check /health, the web UI and /build.json.
#
#   ops/smoke.sh <folder>        e.g. live.next
#
# Prints "smoke ok: server <build>, web <build>" or what failed with the server's log.
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -eq 1 ] && [ -n "$1" ] || { echo "usage: ops/smoke.sh <folder>" >&2; exit 2; }
cd "$REPO"
DIR="$(cd "$1" && pwd)"
[ -x "$DIR/ganban-server" ] && [ -f "$DIR/dist/index.html" ] || { echo "smoke: $1 has no ganban-server or dist/index.html (ops/build.sh $1)" >&2; exit 1; }

TMP="$(mktemp -d /tmp/ganban-smoke.XXXXXX)"
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "smoke: $1" >&2; echo "--- server log (last 30 lines) ---" >&2; tail -n 30 "$TMP/server.out" >&2 || true; exit 1; }

PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
BASE="http://127.0.0.1:$PORT"

# A clean environment: HOME is the temp folder too, so nothing can fall back to the real app data.
env -i HOME="$TMP" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  GANBAN_DB="$TMP/gansty.db" GANBAN_STORAGE="$TMP/shared" GANBAN_LOG_DIR="$TMP/logs" \
  GANBAN_ADDR="127.0.0.1:$PORT" GANBAN_WEB_DIR="$DIR/dist" \
  GANBAN_RAGRAT_STAGING="$TMP/rag/staging" GANBAN_RAGRAT_OUT="$TMP/rag/out" \
  "$DIR/ganban-server" >"$TMP/server.out" 2>&1 &
PID=$!

HEALTH=""
for _ in $(seq 1 60); do
  kill -0 "$PID" 2>/dev/null || fail "the server exited at start"
  if HEALTH="$(curl -fsS --max-time 2 "$BASE/health" 2>/dev/null)"; then break; fi
  HEALTH=""
  sleep 0.5
done
[ -n "$HEALTH" ] || fail "no answer from /health after 30 s"
printf '%s' "$HEALTH" | grep -q '"status":"ok"' || fail "/health isn't ok: $HEALTH"
SERVER_BUILD="$(printf '%s' "$HEALTH" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')"

curl -fsS --max-time 5 "$BASE/" | grep -qi '<div id="root"' || fail "/ doesn't serve the web UI's index.html"
WEB="$(curl -fsS --max-time 5 "$BASE/build.json")" || fail "no /build.json"
WEB_BUILD="$(printf '%s' "$WEB" | sed -n 's/.*"hash":"\([^"]*\)".*/\1/p')"
[ -n "$WEB_BUILD" ] || fail "/build.json has no build hash: $(printf '%s' "$WEB" | head -c 80)"

echo "smoke ok: server ${SERVER_BUILD:-?}, web ${WEB_BUILD:-?}"
