#!/bin/bash
# Install (or reinstall) the Ganban host server as LaunchAgents on this Mac:
# com.ganban.server (always on: at login and after a crash), com.ganban.backup (03:30 nightly) and
# com.ganban.updater (runs ops/update.sh when kickstarted: the owner's "Update the server" button).
# Safe to run again: it re-renders the plists, restarts the service and waits until /health answers.
#
#   ops/install.sh [--addr IP:PORT] [--share-addr IP:PORT|off] [--share-url URL]
#                  [--client-builds none|desktop|android|desktop,android] [--force] [--dry-run]
#   ops/install.sh --client-keys [--new-keystore] [--dry-run]
#
#   --addr     where the server listens (default: the last install's, else 0.0.0.0:8765). Tailnet only:
#              phones and laptops reach it at http://<this Mac's 100.x address>:<port>. Never funnel it.
#   --share-addr  where the share door listens (GANBAN_SHARE_ADDR), e.g. 127.0.0.1:8770: the second
#              listener that serves only share links, the one part published with `tailscale funnel`
#              (ADR 0006). `off` closes it. Default: $GANBAN_SHARE_ADDR, else the last install's, else off.
#   --share-url   the door's public base URL (GANBAN_SHARE_URL), e.g. https://<machine>.<tailnet>.ts.net.
#              Default: $GANBAN_SHARE_URL, else the last install's.
#   --client-builds  which client apps ops/update.sh builds (GANBAN_CLIENT_BUILDS in install.env):
#              desktop,android, desktop, android or none. none for a host whose devices update from
#              GitHub Releases. Default: $GANBAN_CLIENT_BUILDS, else the last install's, else desktop,android.
#   --force    install even when another process (the desktop app?) holds the port or the database,
#              or when there's no database yet
#   --dry-run  render and lint the plists in a temp folder and print what it would run; change nothing
#   --client-keys  only the keys the client builds are signed with (ADR 0007), in <app data>/keys/:
#              makes the desktop updater's key pair once (never overwrites it), and checks the Android
#              release keystore (keystore.properties), offering to make one when there's none
#   --new-keystore  with --client-keys: make the Android keystore without asking
#
# The service serves the desktop app's database (gansty.db), so it keeps every setting made in the app.
# Only one may run: quit the desktop app on this Mac first (it hosts its own server on the same port
# and writes the same database). The first install builds live/ (npm ci, ops/build.sh, ops/smoke.sh);
# ops/update.sh replaces it later. An old com.scs.gansty.headless agent is stopped and its plist moved
# aside. The answers are kept in <app data>/install.env for the next install and update.sh, and so is
# GANBAN_CLIENT_BUILDS (desktop,android | desktop | android | none: which clients update.sh builds),
# taken from --client-builds, else the environment, else the last install.env.
# Environment overrides, for tests: LAUNCHCTL, LSOF, TAILSCALE, AGENTS_DIR, GANBAN_APP_DIR,
# GANBAN_LOGS, GANBAN_HEALTH_WAIT (seconds), GANBAN_SKIP_BUILD=1.
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${GANBAN_APP_DIR:-$HOME/Library/Application Support/com.scs.gansty}"
LOGS="${GANBAN_LOGS:-$HOME/Library/Logs/ganban}"
AGENTS_DIR="${AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
LSOF="${LSOF:-lsof}"
WAIT="${GANBAN_HEALTH_WAIT:-30}"
DOMAIN="gui/$(id -u)"
ENV_FILE="$APP_DIR/install.env"
DB="$APP_DIR/gansty.db"
LABELS="com.ganban.server com.ganban.backup com.ganban.updater"
LEGACY="com.scs.gansty.headless"
DRY=0
FORCE=0
ADDR=""
SHARE_ADDR=""
SHARE_URL=""
CLIENT_KEYS=0
NEW_KEYSTORE=0
CLIENT_BUILDS_FLAG=""

say() { printf '\033[1m== %s\033[0m\n' "$*"; }
warn() { printf 'install: warning: %s\n' "$*" >&2; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
refuse() {
  if [ "$FORCE" = 1 ]; then warn "$1 (going on: --force)"; return; fi
  printf 'install: %s\n(--force installs anyway.)\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --addr) ADDR="${2:-}"; shift 2 ;;
    --share-addr) SHARE_ADDR="${2:-}"; [ -n "$SHARE_ADDR" ] || SHARE_ADDR=off; shift 2 ;;
    --share-url) SHARE_URL="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    --client-keys) CLIENT_KEYS=1; shift ;;
    --new-keystore) NEW_KEYSTORE=1; shift ;;
    --client-builds) CLIENT_BUILDS_FLAG="${2:-}"; [ -n "$CLIENT_BUILDS_FLAG" ] || die "--client-builds needs a value (none, desktop, android or desktop,android)"; shift 2 ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# ── --client-keys: the keys the client builds are signed with (docs/host/SELF_HOSTING.md § Client builds) ──
client_keys() {
  local keys="$APP_DIR/keys"
  local key="$keys/updater.key" pass="$keys/updater.pass" props="$keys/keystore.properties"
  if [ "$DRY" = 1 ]; then
    say "dry run: would make $key (+ .pub, updater.pass) unless it exists, and check $props"
    return 0
  fi
  mkdir -p "$keys"
  chmod 700 "$keys"

  say "the desktop updater's key: $key"
  if [ -f "$key" ]; then
    echo "  already there: kept. It is never overwritten: a new key means installing every desktop app by hand once."
    [ -f "$key.pub" ] || warn "no $key.pub beside it: the builds need it"
    [ -f "$pass" ] || [ -n "${GANBAN_UPDATER_KEY_PASSWORD+x}" ] || warn "no $pass: set GANBAN_UPDATER_KEY_PASSWORD for the builds"
  else
    command -v openssl >/dev/null 2>&1 || die "openssl not found"
    local pw
    pw="$(openssl rand -hex 24)"
    (umask 077 && printf '%s\n' "$pw" > "$pass")
    if ! (cd "$REPO" && npx tauri signer generate -w "$key" --ci -p "$pw") >/dev/null; then
      rm -f "$pass" "$key" "$key.pub"
      die "npx tauri signer generate failed (run npm ci in $REPO first?)"
    fi
    [ -f "$key" ] && [ -f "$key.pub" ] || { rm -f "$pass"; die "tauri signer generate wrote no $key and $key.pub"; }
    chmod 600 "$key" "$pass"
    chmod 644 "$key.pub"
    echo "  made it, with a random password in $pass (mode 600). The public key ($key.pub) goes into each desktop build."
    echo "  Back up the folder $keys: losing the key means installing the desktop apps by hand once."
  fi

  say "the Android release keystore: $props"
  if [ ! -f "$props" ]; then
    cat <<EOF
  There is none. The APK is signed with the keystore that file names, three lines:
      keyAlias=<the key's alias>
      password=<the keystore's and the key's password (one for both)>
      storeFile=<the keystore file: an absolute path, or one relative to $keys>
  Put your existing keystore (the one your phone's Ganban was signed with) and that file in $keys,
  mode 600. Or make a new one now. A phone whose Ganban was signed with another key must uninstall
  it once (its local data goes; pair it again) before it can install the host's builds.
EOF
    local answer=n
    if [ "$NEW_KEYSTORE" = 1 ]; then
      answer=y
    elif [ -t 0 ]; then
      printf 'Make a new release keystore now? [y/N] '
      read -r answer || answer=n
    fi
    case "$answer" in
      y|Y|yes)
        command -v keytool >/dev/null 2>&1 || die "keytool not found (it comes with Java / Android Studio)"
        local store="$keys/ganban-release.jks" kpw
        [ ! -e "$store" ] || die "$store exists but no $props names it: write $props by hand"
        kpw="$(openssl rand -hex 24)"
        GANBAN_KS_PW="$kpw" keytool -genkeypair -keystore "$store" -storetype PKCS12 -alias ganban \
          -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Ganban, O=Ganban" \
          -storepass:env GANBAN_KS_PW -keypass:env GANBAN_KS_PW >/dev/null 2>&1 \
          || die "keytool could not make $store"
        chmod 600 "$store"
        (umask 077 && printf 'keyAlias=ganban\npassword=%s\nstoreFile=%s\n' "$kpw" "$store" > "$props")
        echo "  made $store and $props (mode 600). Back them up with the updater key."
        warn "phones with a Ganban signed by another key: uninstall it once, then install the host's APK (docs/host/SELF_HOSTING.md § Client builds)"
        ;;
      *) echo "  Skipped: until it's there, update.sh skips the Android build and says so." ;;
    esac
    return 0
  fi
  local store alias kpw
  store="$(sed -n 's/^[[:space:]]*storeFile[[:space:]]*=[[:space:]]*//p' "$props" | tail -n 1)"
  alias="$(sed -n 's/^[[:space:]]*keyAlias[[:space:]]*=[[:space:]]*//p' "$props" | tail -n 1)"
  kpw="$(sed -n 's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//p' "$props" | tail -n 1)"
  [ -n "$store" ] && [ -n "$alias" ] && [ -n "$kpw" ] || die "$props needs keyAlias=, password= and storeFile="
  case "$store" in /*) ;; *) store="$keys/$store" ;; esac
  [ -f "$store" ] || die "$props names $store, which isn't there"
  if command -v keytool >/dev/null 2>&1; then
    GANBAN_KS_PW="$kpw" keytool -list -keystore "$store" -alias "$alias" -storepass:env GANBAN_KS_PW >/dev/null 2>&1 \
      || die "keytool can't open the key '$alias' in $store with that password"
  fi
  case "$(ls -l "$props" | cut -c5-10)" in ------) ;; *) warn "$props is readable by others: chmod 600 it" ;; esac
  echo "  ok: key '$alias' in $store"
}
if [ "$CLIENT_KEYS" = 1 ]; then
  client_keys
  exit 0
fi

NODE=""
for n in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ]; then NODE="$n"; break; fi
done
[ -n "$NODE" ] || die "node not found: brew install node"

# What the last install chose, unless given now.
CLIENTS_ENV="${GANBAN_CLIENT_BUILDS-}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  [ -n "$ADDR" ] || ADDR="${GANBAN_INSTALL_ADDR:-}"
fi
ADDR="${ADDR:-0.0.0.0:8765}"
# The server parses it as a socket address and panics on anything else.
printf '%s' "$ADDR" | grep -Eq '^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}$' \
  || die "--addr must be IP:PORT, e.g. 0.0.0.0:8765 (got '$ADDR')"
PORT="${ADDR##*:}"
HOST="${ADDR%:*}"
case "$HOST" in 0.0.0.0|"[::]") HOST=127.0.0.1 ;; esac
HEALTH="http://$HOST:$PORT/health"
say "address: $ADDR (health: $HEALTH)"

# The share door (ADR 0006): now's flags, else the environment, else the last install's.
[ -n "$SHARE_ADDR" ] || SHARE_ADDR="${GANBAN_SHARE_ADDR:-${GANBAN_INSTALL_SHARE_ADDR:-}}"
[ -n "$SHARE_URL" ] || SHARE_URL="${GANBAN_SHARE_URL:-${GANBAN_INSTALL_SHARE_URL:-}}"
if [ "$SHARE_ADDR" = off ]; then SHARE_ADDR=""; SHARE_URL=""; fi
SHARE_URL="${SHARE_URL%/}"
if [ -n "$SHARE_ADDR" ]; then
  printf '%s' "$SHARE_ADDR" | grep -Eq '^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9A-Fa-f:]+\]):[0-9]{1,5}$' \
    || die "--share-addr must be IP:PORT, e.g. 127.0.0.1:8770 (got '$SHARE_ADDR')"
  [ "${SHARE_ADDR##*:}" != "$PORT" ] || die "--share-addr must use another port than --addr ($PORT)"
  case "${SHARE_ADDR%:*}" in
    127.0.0.1|"[::1]") ;;
    *) warn "the share door listens on ${SHARE_ADDR%:*}; 127.0.0.1 is enough for tailscale funnel" ;;
  esac
  [ -n "$SHARE_URL" ] || warn "no --share-url: links can be made, but they get no public URL"
  say "share door: $SHARE_ADDR (public URL: ${SHARE_URL:-none})"
elif [ -n "$SHARE_URL" ]; then
  warn "--share-url without --share-addr: no share door is opened"
fi
if [ -n "$SHARE_URL" ]; then
  # Strict: it's written into install.env, which is sourced later.
  printf '%s' "$SHARE_URL" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
    || die "--share-url must be a base URL like https://mac-studio.tail1234.ts.net (got '$SHARE_URL')"
fi

[ -f "$DB" ] || refuse "no database at $DB: open the desktop app on this Mac once, set it up (Ollama, Tailscale and the rest) and quit it, so the service starts with your settings"

# One server per port and one writer per database. Our own agents' processes don't count.
OURS=" "
for l in $LABELS $LEGACY; do
  OURS="$OURS$("$LAUNCHCTL" list 2>/dev/null | awk -v l="$l" '$3 == l && $1 ~ /^[0-9]+$/ { printf "%s ", $1 }' || true)"
done
HOLDERS=""
for pid in $({ "$LSOF" -t -nP -iTCP:"$PORT" -sTCP:LISTEN; [ -f "$DB" ] && "$LSOF" -t -- "$DB"; } 2>/dev/null | sort -u); do
  case "$OURS" in *" $pid "*) continue ;; esac
  HOLDERS="$HOLDERS
  pid $pid: $(ps -o comm= -p "$pid" 2>/dev/null || echo '?')"
done
if [ -n "$HOLDERS" ]; then
  refuse "another process holds port $PORT or the database:$HOLDERS
Quit the desktop app on this Mac (or stop npm run serve:headless) first: two servers can't share the port, and two writers can damage the database."
fi

# The service's PATH: launchd's own is /usr/bin:/bin:/usr/sbin:/sbin, and member agents need pi and node.
SVC_PATH=""
addp() { case ":$SVC_PATH:" in *":$1:"*) ;; *) SVC_PATH="${SVC_PATH:+$SVC_PATH:}$1" ;; esac; }
# The updater (same environment) also builds: node and npm, cargo, git, and Java for the clients.
# The node found above first: update.sh can't run without it, even when it isn't on this shell's PATH.
addp "$(dirname "$NODE")"
for c in pi node npm cargo git java; do p="$(command -v "$c" 2>/dev/null || true)"; [ -n "$p" ] && addp "$(dirname "$p")"; done
if [ -d "$HOME/.cargo/bin" ]; then addp "$HOME/.cargo/bin"; fi
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do addp "$d"; done

# What the client builds need beyond the server's environment, as this shell has it: the Android
# toolchain and the keys' locations when they aren't the defaults (no passwords).
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$ANDROID_HOME" ] && [ -d "$HOME/Library/Android/sdk" ]; then ANDROID_HOME="$HOME/Library/Android/sdk"; fi
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
BUILD_ENV_KEYS="ANDROID_HOME NDK_HOME JAVA_HOME CARGO_TARGET_DIR GANBAN_UPDATER_KEY GANBAN_ANDROID_KEYSTORE_PROPS GANBAN_CLIENT_FULL"
export ANDROID_HOME JAVA_HOME

# Which clients update.sh builds: --client-builds, else the environment's choice, else the last install's.
if [ -n "$CLIENTS_ENV" ]; then GANBAN_CLIENT_BUILDS="$CLIENTS_ENV"; fi
if [ -n "$CLIENT_BUILDS_FLAG" ]; then GANBAN_CLIENT_BUILDS="$CLIENT_BUILDS_FLAG"; fi
CLIENT_BUILDS="${GANBAN_CLIENT_BUILDS:-desktop,android}"
printf '%s' "$CLIENT_BUILDS" | grep -Eq '^(none|desktop|android|desktop,android|android,desktop)$' \
  || die "GANBAN_CLIENT_BUILDS (or --client-builds) must be desktop,android, desktop, android or none (got '$CLIENT_BUILDS')"
if [ "$CLIENT_BUILDS" = none ]; then say "client builds: none (devices update from GitHub Releases)"
else say "client builds: $CLIENT_BUILDS"; fi

# Reinstalling takes the updater down, which would kill an update under way.
UPD_PID="$("$LAUNCHCTL" list 2>/dev/null | awk '$3 == "com.ganban.updater" && $1 ~ /^[0-9]+$/ { print $1 }' || true)"
if [ -n "$UPD_PID" ]; then
  refuse "an update is running (com.ganban.updater, pid $UPD_PID): wait for it to finish (or watch $LOGS/update.log)"
fi

if [ "$DRY" = 1 ]; then
  OUT="$(mktemp -d /tmp/ganban-install.XXXXXX)"
  RUN() { printf '  (dry run) %s\n' "$*"; }
else
  OUT="$AGENTS_DIR"
  RUN() { "$@"; }
fi

say "folders: $APP_DIR/backups, $LOGS"
RUN mkdir -p "$APP_DIR/backups" "$LOGS" "$AGENTS_DIR"

if [ "${GANBAN_SKIP_BUILD:-0}" != 1 ] && { [ ! -x "$REPO/live/ganban-server" ] || [ ! -f "$REPO/live/dist/index.html" ]; }; then
  say "no build in live/ yet: build and smoke-test one"
  cd "$REPO"
  # Always: a node_modules from an older checkout lacks newer packages (vite then fails to resolve them).
  RUN npm ci --no-audit --no-fund
  RUN bash ops/build.sh live.next
  RUN bash ops/smoke.sh live.next
  RUN rm -rf live
  RUN mv live.next live
fi

say "plists → $OUT"
mkdir -p "$OUT"
for name in $LABELS; do
  # shellcheck disable=SC2097,SC2098
  REPO="$REPO" APP_DIR="$APP_DIR" LOGS="$LOGS" ADDR="$ADDR" SVC_PATH="$SVC_PATH" \
    SHARE_ADDR="$SHARE_ADDR" SHARE_URL="$SHARE_URL" BUILD_ENV_KEYS="$BUILD_ENV_KEYS" \
    "$NODE" -e '
      const fs = require("node:fs");
      const x = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const e = process.env;
      const map = { REPO: e.REPO, APP_DIR: e.APP_DIR, LOGS: e.LOGS, ADDR: e.ADDR, PATH: e.SVC_PATH };
      // The share door variables, only when set (an empty GANBAN_SHARE_ADDR would still be "set").
      const kv = (k, v) => (v ? `    <key>${k}</key>\n    <string>${x(v)}</string>\n` : "");
      const raw = {
        SHARE_ENV: kv("GANBAN_SHARE_ADDR", e.SHARE_ADDR) + kv("GANBAN_SHARE_URL", e.SHARE_URL),
        BUILD_ENV: e.BUILD_ENV_KEYS.split(" ").map((k) => kv(k, e[k])).join(""),
      };
      const out = fs.readFileSync(process.argv[1], "utf8")
        .replace(/^@SHARE_ENV@\n/m, () => raw.SHARE_ENV)
        .replace(/^@BUILD_ENV@\n/m, () => raw.BUILD_ENV)
        .replace(/@([A-Z_]+)@/g, (m, k) => (k in map ? x(map[k]) : m));
      if (/@[A-Z_]+@/.test(out)) { console.error("unfilled field in " + process.argv[1]); process.exit(1); }
      fs.writeFileSync(process.argv[2], out);
    ' "$REPO/ops/launchd/$name.plist.in" "$OUT/$name.plist"
  plutil -lint "$OUT/$name.plist" >/dev/null || die "$OUT/$name.plist does not lint"
done

if [ "$DRY" = 0 ]; then
  (umask 077 && cat > "$ENV_FILE" <<EOF
# Written by ops/install.sh; read by install.sh and update.sh.
GANBAN_INSTALL_ADDR='$ADDR'
GANBAN_INSTALL_HEALTH='$HEALTH'
GANBAN_INSTALL_SHARE_ADDR='$SHARE_ADDR'
GANBAN_INSTALL_SHARE_URL='$SHARE_URL'
GANBAN_CLIENT_BUILDS='$CLIENT_BUILDS'
EOF
  )
fi

loaded() { "$LAUNCHCTL" print "$DOMAIN/$1" >/dev/null 2>&1; }
stop() {
  RUN "$LAUNCHCTL" bootout "$DOMAIN/$1" || true
  # bootout returns before the job is gone, and bootstrap refuses it until then.
  if [ "$DRY" = 0 ]; then
    for _ in $(seq 1 20); do loaded "$1" || break; sleep 0.5; done
  fi
}

say "launchd: $DOMAIN"
for l in $LEGACY; do
  if loaded "$l"; then say "stopping the old $l"; stop "$l"; fi
  if [ -f "$AGENTS_DIR/$l.plist" ]; then
    say "moving the old $AGENTS_DIR/$l.plist aside to $APP_DIR/retired-$l.plist (it would start again at login)"
    RUN mv -f "$AGENTS_DIR/$l.plist" "$APP_DIR/retired-$l.plist"
  fi
done
for name in $LABELS; do
  # Reinstall: take the old one down first (bootstrap refuses a loaded label).
  if [ "$DRY" = 1 ] || loaded "$name"; then stop "$name"; fi
  RUN "$LAUNCHCTL" bootstrap "$DOMAIN" "$OUT/$name.plist"
done

if [ "$DRY" = 1 ]; then
  say "dry run: plists in $OUT; would wait on $HEALTH"
  exit 0
fi

say "waiting on $HEALTH"
for _ in $(seq 1 "$WAIT"); do
  if body="$(trap - ERR; curl -fsS --max-time 2 "$HEALTH" 2>/dev/null)"; then  # bash 3.2: see update.sh wait_health
    say "up: $body"
    # Where phones and laptops connect: this Mac's tailnet address.
    TS="${TAILSCALE-}"
    if [ -z "${TAILSCALE+x}" ]; then
      if command -v tailscale >/dev/null 2>&1; then TS="$(command -v tailscale)"
      elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
      fi
    fi
    IP=""
    if [ -n "$TS" ] && [ -x "$TS" ]; then IP="$("$TS" ip -4 2>/dev/null | head -1 || true)"; fi
    [ -n "$IP" ] || IP="<this Mac's 100.x address>"
    case "${ADDR%:*}" in
      0.0.0.0|"[::]") echo "Clients connect to http://$IP:$PORT (tailnet only)." ;;
      *) echo "Clients connect to http://${ADDR%:*}:$PORT." ;;
    esac
    if [ -n "$SHARE_ADDR" ]; then
      echo "Share door on $SHARE_ADDR. Publish it (and only it) with: tailscale funnel --bg ${SHARE_ADDR##*:}"
    fi
    echo "Keep the desktop app closed on this Mac while the service runs. Updates: ops/update.sh"
    if [ "$CLIENT_BUILDS" != none ] && [ ! -f "${GANBAN_UPDATER_KEY:-$APP_DIR/keys/updater.key}" ]; then
      echo "Client builds: run ops/install.sh --client-keys once (docs/host/SELF_HOSTING.md § Client builds)."
    fi
    exit 0
  fi
  sleep 1
done
die "no answer from $HEALTH after $WAIT s: see $LOGS/server.err.log and $APP_DIR/logs/"
