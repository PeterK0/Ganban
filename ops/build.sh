#!/bin/bash
# Build what the host service runs into one folder: the server binary and the web UI it serves.
#
#   ops/build.sh <folder>        e.g. live.next (relative to the repo)
#
# <folder>/ganban-server  a copy of target/release/ganban-server, so a later cargo build can't touch it
# <folder>/dist/          vite's build of the web UI (GANBAN_WEB_DIR points here)
# Needs node_modules (npm ci) and cargo.
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -eq 1 ] && [ -n "$1" ] || { echo "usage: ops/build.sh <folder>" >&2; exit 2; }
cd "$REPO"
OUT="$1"

rm -rf "$OUT"
mkdir -p "$OUT"
npx vite build --outDir "$OUT/dist" --emptyOutDir --logLevel warn
cargo build --release -p ganban-server
cp "${CARGO_TARGET_DIR:-target}/release/ganban-server" "$OUT/ganban-server"
[ -f "$OUT/dist/index.html" ] && [ -x "$OUT/ganban-server" ] || { echo "build: $OUT is missing index.html or the binary" >&2; exit 1; }
