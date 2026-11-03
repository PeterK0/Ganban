#!/usr/bin/env bash
#
# A throwaway Ganban host for QA: this checkout's ganban-server and web build, on a fresh copy of the seeded test
# database. It never opens a real gansty.db.
#
#   scripts/qa-host.sh <port>            # e.g. scripts/qa-host.sh 8823, then open http://127.0.0.1:8823/
#   scripts/qa-host.sh <port> --build    # rebuild the server and dist/ first, even if they exist
#
# What it does:
#   1. Builds what's missing: target/debug/ganban-server (cargo build -p ganban-server) and dist/ (npx vite build).
#      With --build it rebuilds both, so the host runs your latest changes.
#   2. Seeds /tmp/gilt-qa/seed.db with scripts/gilt-qa-seed.mjs if it doesn't exist yet (delete it to re-seed; set
#      GILT_QA_DIR=/tmp/<folder> to keep your own seed).
#   3. Copies the seed to /tmp/ganban-qa-<port>/ (a fresh copy every run) and serves it on 127.0.0.1:<port>.
#
# The loopback browser is the host's owner, so no sign-in is needed. Ctrl-C stops the host. Run it in its own terminal.
# docs/dev/TESTING.md § QA host has the details.
set -euo pipefail

usage() { echo "usage: scripts/qa-host.sh <port> [--build]" >&2; exit 2; }
PORT="${1:-}"
[[ "$PORT" =~ ^[0-9]+$ ]] || usage
REBUILD=0
case "${2:-}" in
  "") ;;
  --build) REBUILD=1 ;;
  *) usage ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO/target/debug/ganban-server"
SEED="${GILT_QA_DIR:-/tmp/gilt-qa}/seed.db"
DIR="/tmp/ganban-qa-$PORT"
DB="$DIR/qa.db"

# Refuse a port someone already serves (another QA host, or a real one).
if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/health"; then
  echo "something already listens on 127.0.0.1:$PORT; pick another port" >&2
  exit 1
fi

cd "$REPO"
if [[ $REBUILD == 1 || ! -x "$SERVER" ]]; then
  echo "▶ cargo build -p ganban-server"
  nice -n 10 cargo build -p ganban-server
fi
if [[ $REBUILD == 1 || ! -f "$REPO/dist/index.html" ]]; then
  echo "▶ npx vite build"
  npx vite build
fi
if [[ ! -f "$SEED" ]]; then
  echo "▶ node scripts/gilt-qa-seed.mjs"
  node scripts/gilt-qa-seed.mjs
fi

# A fresh copy every run: the host writes to it, the seed stays clean.
rm -rf "$DIR"
mkdir -p "$DIR"
cp "$SEED" "$DB"
for ext in wal shm; do
  if [[ -f "$SEED-$ext" ]]; then cp "$SEED-$ext" "$DB-$ext"; fi
done

echo "▶ QA host on http://127.0.0.1:$PORT/  (database $DB; Ctrl-C to stop)"
export GANBAN_DB="$DB"
export GANBAN_STORAGE="$DIR/files"
export GANBAN_WEB_DIR="$REPO/dist"
export GANBAN_ADDR="127.0.0.1:$PORT"
exec "$SERVER"
