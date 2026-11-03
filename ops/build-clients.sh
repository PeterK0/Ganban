#!/bin/bash
# Build, sign and publish the client apps the host offers (ADR 0007, docs/design/UPDATES.md): the desktop
# app for this Mac with Tauri's updater artifacts, and the Android APK (arm64, release). ops/update.sh
# runs it once the new server is healthy; run it alone to rebuild the clients from this checkout.
#
#   ops/build-clients.sh [--dry-run]
#
# Each client's version is <major>.<minor> from src-tauri/tauri.conf.json plus the commit count
# (1.0.<git rev-list --count HEAD>); Android's version code is 500000 + count, which only grows.
# Published atomically into <APP_DIR>/client-builds/{desktop/<target>-<arch>,android}/ with a
# manifest.json: the new file goes in first, then the manifest, then the old file goes. A client
# whose tool or key is missing is skipped, and a failed build keeps the previous one.
# It prints one line per client ("desktop: built 1.0.975", "android: skipped: <why>",
# "android: failed: <why>"), and writes the same into <APP_DIR>/update-status.json (clients.*).
# The builds run with nice; their output goes to <LOGS>/update.log only. It exits 0 unless misused:
# a client failing never fails the host's update.
#
# Both builds are on the `host` update channel (VITE_UPDATE_CHANNEL=host, ADR 0008): they update from
# the host they're connected to, never from GitHub, and carry only the host's updater key.
#
# Environment:
#   GANBAN_CLIENT_BUILDS   desktop,android (the default), one of them, or none
#   GANBAN_CLIENT_FULL=1   the desktop app with the full engine bundle (tauri.dist.conf.json)
#   GANBAN_UPDATER_KEY     the updater's private key (default <APP_DIR>/keys/updater.key; its public
#                          key is <key>.pub). Password: GANBAN_UPDATER_KEY_PASSWORD, else
#                          <APP_DIR>/keys/updater.pass. Made by ops/install.sh --client-keys.
#   GANBAN_ANDROID_KEYSTORE_PROPS  the release keystore's properties (default
#                          <APP_DIR>/keys/keystore.properties: keyAlias, password, storeFile)
#   ANDROID_HOME, NDK_HOME, JAVA_HOME  the Android toolchain (found under ~/Library/Android/sdk and
#                          Android Studio when unset)
#   GANBAN_APP_DIR, GANBAN_LOGS, CARGO_TARGET_DIR
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${GANBAN_APP_DIR:-$HOME/Library/Application Support/com.scs.gansty}"
LOGS="${GANBAN_LOGS:-$HOME/Library/Logs/ganban}"
LOG="$LOGS/update.log"
STATUS="$APP_DIR/update-status.json"
OUT="$APP_DIR/client-builds"
KEYS="$APP_DIR/keys"
DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: ops/build-clients.sh [--dry-run]" >&2; exit 2 ;;
esac

WANT="${GANBAN_CLIENT_BUILDS:-desktop,android}"
case ",$WANT," in
  *,none,*) WANT="" ;;
esac
wants() { case ",$WANT," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

cd "$REPO"
# The update channel, read by the frontend (import.meta.env) and by src-tauri (option_env!). A repo
# left in the environment would mean nothing on this channel, so it goes.
export VITE_UPDATE_CHANNEL=host
unset VITE_UPDATE_REPO
COUNT="$(git rev-list --count HEAD)"
# major.minor from the app's version; the patch is the commit count, so every commit is newer.
APP_VERSION="$(node "$REPO/ops/json.mjs" get "$REPO/src-tauri/tauri.conf.json" version || true)"
if ! [[ "$APP_VERSION" =~ ^([0-9]+)\.([0-9]+)\. ]]; then
  echo "build-clients: no major.minor version in src-tauri/tauri.conf.json (got \"$APP_VERSION\")" >&2
  exit 1
fi
VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$COUNT"
CODE=$((500000 + COUNT))
COMMIT="$(git rev-parse --short HEAD)"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/target}"
case "$TARGET_DIR" in /*) ;; *) TARGET_DIR="$REPO/$TARGET_DIR" ;; esac

if [ "$DRY" = 0 ]; then mkdir -p "$LOGS" "$OUT"; fi
TMP="$(mktemp -d /tmp/ganban-clients.XXXXXX)"
ANDROID_PROPS_DEST="$REPO/src-tauri/gen/android/keystore.properties"
cleanup() {
  # The build-time copy of the keystore's properties never outlives the build.
  if [ -f "$TMP/keystore.properties.ours" ]; then
    rm -f "$ANDROID_PROPS_DEST"
    if [ -f "$TMP/keystore.properties.saved" ]; then mv -f "$TMP/keystore.properties.saved" "$ANDROID_PROPS_DEST"; fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
# A copy a killed run left behind (SIGKILL, power loss) carries this mark: remove it now.
PROPS_MARK="# written by ops/build-clients.sh for one build; removed after it"
if [ "$DRY" = 0 ] && [ -f "$ANDROID_PROPS_DEST" ] && head -n 1 "$ANDROID_PROPS_DEST" | grep -qxF "$PROPS_MARK"; then
  rm -f "$ANDROID_PROPS_DEST"
fi

log() { if [ "$DRY" = 0 ]; then printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; fi; }
now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
# One client's result: the terminal line, the log and the status file.
result() {
  touch "$TMP/done.$1"
  echo "$1: $2"
  log "== $1: $2"
  if [ "$DRY" = 0 ]; then node "$REPO/ops/json.mjs" set "$STATUS" "clients.$1=$2" || true; fi
}
# Why a build failed, in a few words: the last error line it logged since $1 (a byte offset).
why() {
  local line
  line="$(tail -c +"$(( $1 + 1 ))" "$LOG" 2>/dev/null | grep -iE 'error|failed|cannot|not found' | grep -v '^\s*$' | tail -n 1 | tr -d '\r' | cut -c1-160 || true)"
  echo "${line:-see $LOG}"
}
log_size() { if [ -f "$LOG" ]; then wc -c < "$LOG" | tr -d ' '; else echo 0; fi; }

# Publish $2 (a file) as $3 (its published name) into $1 with the manifest made by the rest
# (json.mjs pairs): the file first, then the manifest (one rename, so a reader sees the old build
# or the new one, never half), then the files the old manifest named.
publish() {
  local dir="$1" src="$2" name="$3"; shift 3
  mkdir -p "$dir"
  rm -f "$dir"/.*.tmp "$dir"/.manifest.json.new
  cp "$src" "$dir/.$name.tmp"
  mv -f "$dir/.$name.tmp" "$dir/$name"
  # The updater's signature beside its bundle (the manifest carries it too).
  if [ -f "$src.sig" ]; then cp "$src.sig" "$dir/.$name.sig.tmp" && mv -f "$dir/.$name.sig.tmp" "$dir/$name.sig"; fi
  node "$REPO/ops/json.mjs" new "$dir/.manifest.json.new" "file=$name" "$@"
  mv -f "$dir/.manifest.json.new" "$dir/manifest.json"
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    case "${f##*/}" in manifest.json|"$name"|"$name.sig") ;; *) rm -f "$f" ;; esac
  done
}

# ── desktop ──
desktop() {
  [ "$(uname -s)" = Darwin ] || { result desktop "skipped: not a Mac"; return; }
  local key="${GANBAN_UPDATER_KEY:-$KEYS/updater.key}"
  [ -f "$key" ] || { result desktop "skipped: no updater key at $key (ops/install.sh --client-keys)"; return; }
  [ -f "$key.pub" ] || { result desktop "skipped: no public key at $key.pub"; return; }
  local pass="${GANBAN_UPDATER_KEY_PASSWORD-}"
  if [ -z "${GANBAN_UPDATER_KEY_PASSWORD+x}" ]; then
    [ -f "$KEYS/updater.pass" ] || { result desktop "skipped: no password (GANBAN_UPDATER_KEY_PASSWORD or $KEYS/updater.pass)"; return; }
    pass="$(cat "$KEYS/updater.pass")"
  fi
  command -v cargo >/dev/null 2>&1 || { result desktop "skipped: no cargo on PATH"; return; }
  command -v npx >/dev/null 2>&1 || { result desktop "skipped: no npx on PATH"; return; }
  local arch
  case "$(uname -m)" in arm64|aarch64) arch=aarch64 ;; x86_64) arch=x86_64 ;; *) result desktop "skipped: unknown CPU $(uname -m)"; return ;; esac
  local conf="$TMP/desktop.conf.json"
  node "$REPO/ops/json.mjs" new "$conf" "version=$VERSION" 'bundle.createUpdaterArtifacts:=true' "plugins.updater.pubkey=$(cat "$key.pub")"
  # The normal client bundle; GANBAN_CLIENT_FULL=1 merges the full engine bundle's config first.
  local full=""
  if [ "${GANBAN_CLIENT_FULL:-0}" = 1 ]; then full=src-tauri/tauri.dist.conf.json; fi
  local bundle_dir="$TARGET_DIR/release/bundle/macos"
  if [ "$DRY" = 1 ]; then
    echo "  (dry run) nice -n 10 npx tauri build --bundles app --ci ${full:+--config $full }--config <version $VERSION, updater artifacts, the public key>"
    result desktop "would build $VERSION (darwin-$arch)"
    return
  fi
  local from; from="$(log_size)"
  log "== desktop: tauri build $VERSION (darwin-$arch)${full:+, full bundle}"
  rm -f "$bundle_dir"/*.app.tar.gz "$bundle_dir"/*.app.tar.gz.sig
  if [ -n "$full" ] && ! node scripts/check-bundle-resources.mjs >> "$LOG" 2>&1; then
    result desktop "failed: the full bundle's resources are missing (scripts/check-bundle-resources.mjs)"
    return
  fi
  if ! TAURI_SIGNING_PRIVATE_KEY="$key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$pass" \
      nice -n 10 npx tauri build --bundles app --ci ${full:+--config "$full"} --config "$conf" >> "$LOG" 2>&1; then
    result desktop "failed: $(why "$from")"
    return
  fi
  local tarball
  tarball="$(ls -t "$bundle_dir"/*.app.tar.gz 2>/dev/null | head -n 1 || true)"
  if [ -z "$tarball" ] || [ ! -f "$tarball.sig" ]; then
    result desktop "failed: no signed .app.tar.gz in $bundle_dir"
    return
  fi
  publish "$OUT/desktop/darwin-$arch" "$tarball" "Ganban_${VERSION}.app.tar.gz" \
    "version=$VERSION" "target=darwin" "arch=$arch" "pubDate=$(now)" "commit=$COMMIT" \
    "signature=$(cat "$tarball.sig")" "size:=$(wc -c < "$tarball" | tr -d ' ')"
  result desktop "built $VERSION"
}

# ── android ──
android() {
  local props="${GANBAN_ANDROID_KEYSTORE_PROPS:-$KEYS/keystore.properties}"
  [ -f "$props" ] || { result android "skipped: no keystore at $props (ops/install.sh --client-keys)"; return; }
  local store alias pw
  store="$(sed -n 's/^[[:space:]]*storeFile[[:space:]]*=[[:space:]]*//p' "$props" | tail -n 1)"
  alias="$(sed -n 's/^[[:space:]]*keyAlias[[:space:]]*=[[:space:]]*//p' "$props" | tail -n 1)"
  pw="$(sed -n 's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//p' "$props" | tail -n 1)"
  [ -n "$store" ] && [ -n "$alias" ] && [ -n "$pw" ] || { result android "skipped: $props needs keyAlias, password and storeFile"; return; }
  case "$store" in /*) ;; *) store="$(cd "$(dirname "$props")" && pwd)/$store" ;; esac
  [ -f "$store" ] || { result android "skipped: no keystore file at $store"; return; }
  if [ -z "${ANDROID_HOME-}" ] && [ -n "${ANDROID_SDK_ROOT-}" ]; then export ANDROID_HOME="$ANDROID_SDK_ROOT"; fi
  if [ -z "${ANDROID_HOME-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk"; fi
  [ -n "${ANDROID_HOME-}" ] && [ -d "$ANDROID_HOME" ] || { result android "skipped: no Android SDK (ANDROID_HOME)"; return; }
  if [ -z "${NDK_HOME-}" ]; then
    # The newest NDK (numeric sort by version field; sort -V isn't on every macOS).
    NDK_HOME="$(ls "$ANDROID_HOME/ndk" 2>/dev/null | sort -t . -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"
    if [ -n "$NDK_HOME" ]; then NDK_HOME="$ANDROID_HOME/ndk/$NDK_HOME"; fi
    export NDK_HOME
  fi
  [ -n "$NDK_HOME" ] && [ -d "$NDK_HOME" ] || { result android "skipped: no Android NDK (NDK_HOME, or $ANDROID_HOME/ndk/)"; return; }
  if [ -z "${JAVA_HOME-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  fi
  { [ -n "${JAVA_HOME-}" ] && [ -x "$JAVA_HOME/bin/java" ]; } || command -v java >/dev/null 2>&1 \
    || { result android "skipped: no Java (JAVA_HOME)"; return; }
  command -v cargo >/dev/null 2>&1 || { result android "skipped: no cargo on PATH"; return; }
  command -v npx >/dev/null 2>&1 || { result android "skipped: no npx on PATH"; return; }
  local conf="$TMP/android.conf.json"
  node "$REPO/ops/json.mjs" new "$conf" "version=$VERSION" "bundle.android.versionCode:=$CODE"
  if [ "$DRY" = 1 ]; then
    echo "  (dry run) nice -n 10 npx tauri android build --apk --target aarch64 --ci --config <version $VERSION, versionCode $CODE> (signed with $props)"
    result android "would build $VERSION ($CODE)"
    return
  fi
  local from; from="$(log_size)"
  log "== android: tauri android build $VERSION (versionCode $CODE)"
  # build.gradle.kts reads gen/android/keystore.properties: a copy with an absolute storeFile,
  # removed (and any copy that was there put back) when this script ends.
  if [ -f "$ANDROID_PROPS_DEST" ]; then mv -f "$ANDROID_PROPS_DEST" "$TMP/keystore.properties.saved"; fi
  touch "$TMP/keystore.properties.ours"
  (umask 077 && printf '%s\nkeyAlias=%s\npassword=%s\nstoreFile=%s\n' "$PROPS_MARK" "$alias" "$pw" "$store" > "$ANDROID_PROPS_DEST")
  local apk_dir="$REPO/src-tauri/gen/android/app/build/outputs/apk"
  touch "$TMP/stamp"
  sleep 1
  if ! nice -n 10 npx tauri android build --apk --target aarch64 --ci --config "$conf" >> "$LOG" 2>&1; then
    result android "failed: $(why "$from")"
    return
  fi
  local apk
  apk="$(find "$apk_dir" -name '*release*.apk' -newer "$TMP/stamp" 2>/dev/null | grep -v unsigned | head -n 1 || true)"
  if [ -z "$apk" ]; then
    result android "failed: no signed release APK in $apk_dir"
    return
  fi
  local apksigner
  apksigner="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | tail -n 1 || true)"
  if [ -n "$apksigner" ] && ! "$apksigner" verify "$apk" >> "$LOG" 2>&1; then
    result android "failed: the APK's signature doesn't verify (apksigner)"
    return
  fi
  publish "$OUT/android" "$apk" "Ganban_${VERSION}.apk" \
    "version=$VERSION" "versionCode:=$CODE" "pubDate=$(now)" "commit=$COMMIT" \
    "sha256=$(shasum -a 256 "$apk" | cut -d' ' -f1)" "size:=$(wc -c < "$apk" | tr -d ' ')"
  result android "built $VERSION"
}

# Each client in a subshell with set -e in force (it isn't inside `||`), so an unexpected failure
# ends that client only, and is reported.
for client in desktop android; do
  if ! wants "$client"; then result "$client" "skipped: not in GANBAN_CLIENT_BUILDS"; continue; fi
  set +e
  ( set -e; "$client" )
  rc=$?
  set -e
  if [ "$rc" != 0 ] && [ ! -f "$TMP/done.$client" ]; then result "$client" "failed: the build script stopped (exit $rc; see $LOG)"; fi
done
