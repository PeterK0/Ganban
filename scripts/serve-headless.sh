#!/usr/bin/env bash
#
# Run the Ganban headless server reusing the DESKTOP APP's database + settings.
#
# It serves the SAME SQLite DB the desktop GUI uses, so everything you configured
# in the app — Ollama, ragrat, GIPHY, Tailscale credential, model profiles, shared
# builds — is inherited automatically. Nothing to re-enter.
#
# ⚠️  Quit the desktop app first: only one process may write the DB at a time.
#
# This is for a one-off run in a terminal. To keep the server running on the host (at login,
# after a crash) and update it safely, use ops/install.sh and ops/update.sh (docs/host/SELF_HOSTING.md).
#
#   npm run serve:headless                       # 0.0.0.0:8765
#   GANBAN_ADDR=0.0.0.0:9000 npm run serve:headless
#   GANBAN_DB=/path/to/other.db npm run serve:headless   # a separate DB instead
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Desktop paths (macOS). The headless binary defaults to these too; we set them
# explicitly so they're visible and overridable. On Linux, app data lives under
# ~/.local/share — override GANBAN_APP_DIR there.
APP_DIR="${GANBAN_APP_DIR:-$HOME/Library/Application Support/com.scs.gansty}"
export GANBAN_DB="${GANBAN_DB:-$APP_DIR/gansty.db}"
export GANBAN_STORAGE="${GANBAN_STORAGE:-$APP_DIR/shared}"
export GANBAN_ADDR="${GANBAN_ADDR:-0.0.0.0:8765}"

if [ ! -f "$GANBAN_DB" ]; then
  echo "No database at: $GANBAN_DB" >&2
  echo "Launch the desktop app once and configure it (Ollama / Tailscale / etc.) so the DB exists + holds your settings, then re-run this." >&2
  exit 1
fi

# One writer per DB: if anything already has it open (the desktop app?), warn.
if command -v lsof >/dev/null 2>&1 && lsof -- "$GANBAN_DB" >/dev/null 2>&1; then
  echo "⚠️  $GANBAN_DB is already open by another process — likely the desktop app."
  echo "    Quit it first: two writers can corrupt the database. Continuing in 5s (Ctrl-C to abort)…"
  sleep 5
fi

BIN="$REPO/target/release/ganban-server"
# Always build (incremental — ~1 s when nothing changed). It used to build only
# when the binary was missing, so a restart after `git pull` kept running the
# OLD server under a NEW web UI: features "didn't show up" (map imagery, save
# slots) because the host simply didn't have the routes yet.
if command -v cargo >/dev/null 2>&1; then
  echo "Building ganban-server (release, incremental)…"
  ( cd "$REPO" && cargo build -p ganban-server --release )
elif [ ! -x "$BIN" ]; then
  echo "No ganban-server binary at $BIN and no cargo to build one." >&2
  exit 1
fi

# The web UI this host serves (browsers / phones on the tailnet) is dist/.
if [ -f "$REPO/dist/index.html" ] && [ -n "$(find "$REPO/src" -newer "$REPO/dist/index.html" -type f -print -quit 2>/dev/null)" ]; then
  echo "⚠️  dist/ is older than src/ — browsers on the tailnet get the old UI. Run: npm run build"
fi

PORT="${GANBAN_ADDR##*:}"
echo "Ganban headless server"
echo "  DB:      $GANBAN_DB   (inherits all your desktop settings)"
echo "  Storage: $GANBAN_STORAGE"
echo "  Listen:  $GANBAN_ADDR"
echo "  Connect a laptop/phone to:  http://<this-mac's 100.x Tailscale IP>:$PORT"
echo "  (Tailnet only — never port-forward to the public internet.)"
echo
exec "$BIN"
