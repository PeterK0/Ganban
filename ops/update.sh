#!/bin/bash
# Update the Ganban host server (macOS, installed by ops/install.sh): pull, install, check (tsc, cargo test,
# a private tab's suite where the tree has one), build into a staging folder (live.next/), smoke that build, back up the database, swap it in,
# restart, check. It stops at the first failure; until the swap, the running service and the live/ it runs are
# untouched, so a failure never leaves a new web UI beside an old server. If the new build doesn't come up
# healthy, it rolls back to the previous one (the failed one kept as live.bad/). The build it replaced stays
# in live.prev/ until the next update.
#
#   ops/update.sh [--dry-run]
#
# Once the new build is healthy it builds the client apps (ops/build-clients.sh; GANBAN_CLIENT_BUILDS
# in install.env or the environment: desktop,android by default, none for neither). A client that
# fails is reported on its line and never rolls the server back.
#
# Prints one summary line at the end. Run ops/install.sh first (and again when ops/launchd/ changed).
# The owner's "Update the server" button runs it as the launchd job com.ganban.updater. As it goes it writes
# <APP_DIR>/update-status.json (state, step, times, builds, the clients' lines) and appends everything
# it prints to <LOGS>/update.log; the client builds' own output goes to the log only. One update runs
# at a time: a "running" status whose process is gone (a crash) is cleared. The status is its very
# first write, in plain shell, so a run that dies early (no install.env, node missing from the PATH)
# still says where it stopped.
# Environment overrides, for tests: LAUNCHCTL, LSOF, GANBAN_APP_DIR, GANBAN_LOGS, GANBAN_HEALTH_WAIT.
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${GANBAN_APP_DIR:-$HOME/Library/Application Support/com.scs.gansty}"
LOGS="${GANBAN_LOGS:-$HOME/Library/Logs/ganban}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
LSOF="${LSOF:-lsof}"
WAIT="${GANBAN_HEALTH_WAIT:-30}"
DOMAIN="gui/$(id -u)"
LABEL="com.ganban.server"
DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: ops/update.sh [--dry-run]" >&2; exit 2 ;;
esac

STATUS="$APP_DIR/update-status.json"
LOG="$LOGS/update.log"
OWN=0  # 1 once this run owns the status file
now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
status() { if [ "$OWN" = 1 ]; then node "$REPO/ops/json.mjs" set "$STATUS" "$@" 2>/dev/null || true; fi; }
# A JSON string in plain shell (the early status is written before node is known to be there).
jstr() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | LC_ALL=C tr '\000-\037' ' ')"; }
# The whole status in plain shell: state, step, and finishedAt when it ended.
early_status() {
  local fin=null
  if [ "$1" != running ]; then fin="\"$(now)\""; fi
  printf '{"state":"%s","step":%s,"startedAt":"%s","finishedAt":%s,"fromBuild":null,"toBuild":null,"clients":{"desktop":"","android":""},"pid":%s,"logOffset":%s,"launchdLogOffset":%s}\n' \
    "$1" "$(jstr "$2")" "$STARTED" "$fin" "$$" "$LOG_OFFSET" "$LAUNCHD_OFFSET" > "$STATUS.tmp-$$" && mv -f "$STATUS.tmp-$$" "$STATUS"
}
# Stop before node is known to work: say why in the status and the log.
fail_early() {
  echo "update: $1" >&2
  if [ "$OWN" = 1 ]; then early_status failed "starting: $1"; fi
  exit 1
}

# One update at a time. A "running" status whose process is gone was left by a crash: clear it.
# Plain shell: this runs before node is known to be on the PATH.
if [ "$DRY" = 0 ] && [ -f "$STATUS" ]; then
  if [ "$(sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATUS" | head -n 1)" = running ]; then
    PID="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$STATUS" | head -n 1)"
    if [ -n "$PID" ] && [ "$PID" != "$$" ] && kill -0 "$PID" 2>/dev/null \
        && ps -o command= -p "$PID" 2>/dev/null | grep -q 'update\.sh'; then
      echo "update: another update is running (pid $PID, step \"$(sed -n 's/.*"step"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATUS" | head -n 1)\"). Nothing was changed." >&2
      exit 1
    fi
    if [ -n "$PID" ]; then STALE="$PID"; fi
  fi
fi

# The status first, before anything that needs node, the network or install.env, so every
# failure from here on is attributed to a step. Then everything printed also goes to the log
# (stderr stays stderr on the terminal; launchd keeps its own copy in updater.out.log).
if [ "$DRY" = 0 ]; then
  mkdir -p "$APP_DIR" "$LOGS"
  # A long log starts over (the last one kept as .prev); launchd's copy too.
  for f in "$LOG" "$LOGS/updater.out.log"; do
    if [ -f "$f" ] && [ "$(wc -c < "$f" | tr -d ' ')" -gt 20000000 ]; then mv -f "$f" "$f.prev"; fi
  done
  LOG_OFFSET="$(if [ -f "$LOG" ]; then wc -c < "$LOG" | tr -d ' '; else echo 0; fi)"
  # Where this run's part of launchd's log begins (the server shows it when the run stalls).
  LAUNCHD_OFFSET="$(if [ -f "$LOGS/updater.out.log" ]; then wc -c < "$LOGS/updater.out.log" | tr -d ' '; else echo 0; fi)"
  STARTED="$(now)"
  OWN=1
  early_status running starting || { echo "update: can't write $STATUS" >&2; exit 1; }
  exec > >(tee -a "$LOG") 2> >(tee -a "$LOG" >&2)
  echo "──── ops/update.sh $(date '+%Y-%m-%d %H:%M:%S') (pid $$)"
  if [ -n "${STALE:-}" ]; then echo "update: clearing a stale \"running\" status (pid $STALE is gone)"; fi
fi

[ -f "$APP_DIR/install.env" ] || fail_early "no $APP_DIR/install.env: run ops/install.sh first"
CLIENTS_ENV="${GANBAN_CLIENT_BUILDS-}"
# shellcheck disable=SC1091
. "$APP_DIR/install.env"
HEALTH="${GANBAN_INSTALL_HEALTH:-http://127.0.0.1:8765/health}"
ADDR="${GANBAN_INSTALL_ADDR:-0.0.0.0:8765}"
# The environment's choice wins over install.env's.
if [ -n "$CLIENTS_ENV" ]; then GANBAN_CLIENT_BUILDS="$CLIENTS_ENV"; fi
export GANBAN_CLIENT_BUILDS="${GANBAN_CLIENT_BUILDS:-desktop,android}"
export GANBAN_APP_DIR="$APP_DIR" GANBAN_LOGS="$LOGS"

# The tools the update needs, on this PATH (launchd's comes from ops/install.sh).
if [ "$DRY" = 0 ]; then
  for t in node npm git cargo curl; do
    command -v "$t" >/dev/null 2>&1 || fail_early "$t not found on the updater's PATH ($PATH): run ops/install.sh again on the host"
  done
fi

if [ "$DRY" = 0 ]; then
  # How it ended, whatever path it took.
  finish() {
    local code=$?
    if [ "$code" = 0 ]; then status state=succeeded "finishedAt=$(now)"; else status state=failed "finishedAt=$(now)"; fi
  }
  trap finish EXIT
fi

STEP=""
step() { STEP="$1"; printf '\033[1m== %s\033[0m\n' "$1"; status "step=$1"; }
RUN() { if [ "$DRY" = 1 ]; then printf '  (dry run) %s\n' "$*"; else "$@"; fi; }
build_of() { sed -n 's/.*"build":"\([^"]*\)".*/\1/p'; }
# Wait until /health answers with build $1 (any build when empty); BUILD is what it said last.
# `trap - ERR` inside the probe: macOS's bash 3.2 runs an inherited (set -E) ERR trap for a failing
# command substitution even inside an `if`, so every probe before the server answered printed a
# false "stopped at health" (2026-11-02).
wait_health() {
  BUILD=""
  for _ in $(seq 1 "$WAIT"); do
    if BODY="$(trap - ERR; curl -fsS --max-time 2 "$HEALTH" 2>/dev/null)"; then
      BUILD="$(printf '%s' "$BODY" | build_of)"
      if [ -z "$1" ] || [ "$BUILD" = "$1" ]; then return 0; fi
    fi
    sleep 1
  done
  return 1
}
trap 'echo "update: stopped at \"$STEP\"; nothing swapped and the service was not restarted (still the old build; the new one, if any, is in live.next/)." >&2' ERR

# The desktop app (or another server) on the port or the database would take the restart's place;
# say so now, not after ten minutes of building. The service's own process doesn't count.
STEP="check the port and the database"
status "step=$STEP"
SVC_PID="$("$LAUNCHCTL" list 2>/dev/null | awk -v l="$LABEL" '$3 == l && $1 ~ /^[0-9]+$/ { print $1 }' || true)"
HOLDERS=""
for pid in $({ "$LSOF" -t -nP -iTCP:"${ADDR##*:}" -sTCP:LISTEN; "$LSOF" -t -- "$APP_DIR/gansty.db"; } 2>/dev/null | sort -u); do
  [ "$pid" = "$SVC_PID" ] && continue
  HOLDERS="$HOLDERS
  pid $pid: $(ps -o comm= -p "$pid" 2>/dev/null || echo '?')"
done
if [ -n "$HOLDERS" ]; then
  echo "update: another process holds port ${ADDR##*:} or the database:$HOLDERS
Quit the desktop app on this Mac (or stop npm run serve:headless) and run ops/update.sh again. Nothing was changed." >&2
  exit 1
fi
OLD="$(trap - ERR; curl -fsS --max-time 2 "$HEALTH" 2>/dev/null | build_of || true)"

cd "$REPO"
FROM="$(git rev-parse --short HEAD)"
status "fromBuild=${OLD:-$FROM}"

step "git pull --ff-only"
RUN git pull --ff-only
TO="$(git rev-parse --short HEAD)"
status "toBuild=$TO"

step "npm ci"
RUN npm ci --no-audit --no-fund

step "checks: tsc, cargo test (core, server), tab suites"
RUN npx tsc --noEmit -p .
RUN cargo test -p ganban-core -p ganban-server
# A private build's tab suite, where the tree carries it (the public tree doesn't).
if [ -f scripts/test-extra-tabs.mjs ]; then RUN npm run -s test:extra-tabs; fi

step "build into live.next/"
RUN bash ops/build.sh live.next

step "smoke (the staged build on a throwaway database and a random port)"
SMOKE="$(RUN bash ops/smoke.sh live.next)"
echo "$SMOKE"
NEW="$(printf '%s' "$SMOKE" | sed -n 's/^smoke ok: server \([^,]*\),.*/\1/p')"
if [ -n "$NEW" ]; then status "toBuild=$NEW"; fi

step "backup"
BK="$(RUN bash ops/backup.sh --keep 14)"
echo "$BK"
BK_FILE="$(printf '%s' "$BK" | sed -n 's/^backup \([^ ]*\).*/\1/p')"

trap 'echo "update: stopped at \"$STEP\" during or after the swap: see $LOGS/server.err.log and $APP_DIR/logs/; the old build is in live.prev/" >&2' ERR
step "swap in the new build (the old one kept as live.prev/)"
RUN rm -rf live.prev
if [ -d live ]; then RUN mv live live.prev; fi
RUN mv live.next live

step "restart"
# A fresh stdout log per run of the service (launchd reopens it at the start).
if [ -f "$LOGS/server.log" ]; then RUN mv -f "$LOGS/server.log" "$LOGS/server.log.prev"; fi
RUN "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"

step "health"
if [ "$DRY" = 1 ]; then
  BUILD='(dry run)'
elif ! wait_health "$NEW"; then
  trap - ERR
  if [ -n "$BUILD" ]; then echo "update: $HEALTH answers with build $BUILD, not the new ${NEW:-?}" >&2
  else echo "update: no answer from $HEALTH after $WAIT s: see $LOGS/server.err.log and $APP_DIR/logs/" >&2; fi
  if [ ! -d live.prev ]; then echo "update: no previous build to go back to." >&2; exit 1; fi
  echo "update: rolling back to the previous build (the new one kept as live.bad/)" >&2
  rm -rf live.bad
  mv live live.bad
  mv live.prev live
  "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL" || true
  if wait_health "$OLD"; then
    status "step=health: the new build failed; rolled back to build ${BUILD:-?}"
    echo "update: rolled back: build ${BUILD:-?} serves again. Why the new one failed: $LOGS/server.err.log, server.log and $APP_DIR/logs/" >&2
  else
    status "step=health: the new build failed, and so does the previous one: restore the backup"
    echo "update: the previous build doesn't come up either. Restore the backup ${BK_FILE:-?} (docs/host/SELF_HOSTING.md, Part 6)." >&2
  fi
  exit 1
fi

# The server is healthy: from here on nothing fails the update or rolls it back.
trap - ERR
step "client apps (ops/build-clients.sh: $GANBAN_CLIENT_BUILDS)"
if [ "$DRY" = 1 ]; then
  bash ops/build-clients.sh --dry-run || true
else
  bash ops/build-clients.sh || echo "update: the client builds stopped (see $LOG); the server is updated."
fi

echo "ganban updated ${FROM} → ${TO}: build ${BUILD:-?}, healthy; backup ${BK_FILE:-?}"
