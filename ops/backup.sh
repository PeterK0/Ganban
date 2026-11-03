#!/bin/bash
# Back up the Ganban host's database: sqlite3's online .backup (safe while the server runs and
# writes), a quick_check of the copy, gzip, and only the newest N kept. Run nightly by
# com.ganban.backup (ops/install.sh) and by ops/update.sh before every swap.
#
#   ops/backup.sh [--keep N]          (default 14)
#
# Prints one line: "backup <path> <size>". Environment overrides, for tests: GANBAN_APP_DIR
# (the folder holding gansty.db; backups go to its backups/), SQLITE3.
set -Eeuo pipefail

APP_DIR="${GANBAN_APP_DIR:-$HOME/Library/Application Support/com.scs.gansty}"
DB="$APP_DIR/gansty.db"
DEST="$APP_DIR/backups"
KEEP=14
case "${1:-}" in
  "") ;;
  --keep) KEEP="${2:-}" ;;
  *) echo "usage: ops/backup.sh [--keep N]" >&2; exit 2 ;;
esac
case "$KEEP" in ''|*[!0-9]*) echo "backup: --keep wants a number of 1 or more" >&2; exit 2 ;; esac
KEEP=$((10#$KEEP))
[ "$KEEP" -ge 1 ] || { echo "backup: --keep wants a number of 1 or more" >&2; exit 2; }

SQLITE3="${SQLITE3:-}"
if [ -z "$SQLITE3" ]; then
  if [ -x /usr/bin/sqlite3 ]; then SQLITE3=/usr/bin/sqlite3; else SQLITE3="$(command -v sqlite3 || true)"; fi
fi
[ -n "$SQLITE3" ] || { echo "backup: sqlite3 not found" >&2; exit 1; }
[ -f "$DB" ] || { echo "backup: no database at $DB" >&2; exit 1; }
case "$DEST" in *"'"*) echo "backup: the backup folder's path holds a quote: $DEST" >&2; exit 1 ;; esac

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/gansty-$STAMP.db"
trap 'rm -f "$OUT"' ERR

"$SQLITE3" "$DB" ".timeout 10000" ".backup '$OUT'"
CHECK="$("$SQLITE3" "$OUT" "PRAGMA quick_check;")"
[ "$CHECK" = ok ] || { echo "backup: the copy fails quick_check: $CHECK" >&2; exit 1; }
gzip -f "$OUT"
OUT="$OUT.gz"
trap - ERR

# The newest $KEEP stay; the names sort by time.
for f in "$DEST"/gansty-[0-9]*-[0-9]*.db.gz; do [ -f "$f" ] && basename "$f"; done | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$DEST/$old"
done

echo "backup $OUT $(du -h "$OUT" | cut -f1 | tr -d ' ')"
