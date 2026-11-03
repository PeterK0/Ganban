#!/usr/bin/env bash
#
# pair-link.sh — mint a Ganban pairing/invite link from a HEADLESS host.
#
# The desktop GUI's "Settings -> Sync -> Host this device -> Pair a phone ->
# Copy invite link" has no headless equivalent; this is it. Run it ON the host
# (the machine running ganban-server): it mints a one-time token via the
# loopback admin surface — loopback resolves to the OWNER, so no credential is
# needed — and prints the ready-to-paste link with the host's tailnet address.
#
# Usage:
#   scripts/pair-link.sh                                  # owner device-pairing link (default)
#   scripts/pair-link.sh --project 3 --role member        # invite a teammate to project 3
#   scripts/pair-link.sh --project 3 --role admin --name "Alice"
#   scripts/pair-link.sh --host my-host --port 8765         # override the address/port
#
# Run it from another machine over SSH (it still mints on the host's loopback):
#   ssh you@host 'cd /path/to/Ganban && ./scripts/pair-link.sh'
#
# Paste the printed link into the desktop client's "Run as a client of a host"
# box, or open it in a browser to join as a no-install web client. One-time,
# valid ~24h.
set -euo pipefail

PORT=8765
HOST=""
MODE="device" # device | invite
PROJECT=""
ROLE="member"
NAME=""

usage() { sed -n '3,24p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)    PORT="$2"; shift 2;;
    --host)    HOST="$2"; shift 2;;
    --project) MODE="invite"; PROJECT="$2"; shift 2;;
    --role)    ROLE="$2"; shift 2;;
    --name)    NAME="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
done

# 1. Build the /invoke admin command.
if [ "$MODE" = "invite" ]; then
  [ -n "$PROJECT" ] || { echo "--project <id> is required for an invite" >&2; exit 2; }
  args="{\"projectId\":$PROJECT,\"role\":\"$ROLE\""
  [ -n "$NAME" ] && args="$args,\"displayName\":\"$NAME\""
  args="$args}"
  payload="{\"command\":\"create_invite\",\"args\":$args}"
else
  payload="{\"command\":\"create_device_enrollment\",\"args\":{}}"
fi

# 2. Mint the token over loopback (loopback == owner; no token needed).
resp=$(curl -fsS "http://127.0.0.1:${PORT}/invoke" \
  -H "content-type: application/json" -d "$payload") || {
  echo "Could not reach ganban-server on 127.0.0.1:${PORT}." >&2
  echo "Run this ON the host machine, with the server running (try: curl -s http://127.0.0.1:${PORT}/health)." >&2
  exit 1
}

# Parse {"token":"..."} — jq if present, else a portable sed fallback.
if command -v jq >/dev/null 2>&1; then
  token=$(printf '%s' "$resp" | jq -r '.token // empty')
else
  token=$(printf '%s' "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
fi
[ -n "$token" ] || { echo "No token in response: $resp" >&2; exit 1; }

# 3. Resolve the host's TAILNET address for the link — the client must reach
#    THIS host, not 127.0.0.1. --host wins; else the Tailscale IPv4; else give up
#    with the token so the operator can assemble the link by hand.
if [ -z "$HOST" ]; then
  for ts in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if command -v "$ts" >/dev/null 2>&1 || [ -x "$ts" ]; then
      HOST=$("$ts" ip -4 2>/dev/null | head -1 || true)
      [ -n "$HOST" ] && break
    fi
  done
fi
if [ -z "$HOST" ]; then
  echo "Couldn't auto-detect a tailnet address — re-run with --host <tailnet-ip-or-MagicDNS-name>." >&2
  echo "Token (valid ~24h): $token" >&2
  echo "Then the link is: http://<host>:${PORT}/#invite=${token}" >&2
  exit 1
fi

echo "http://${HOST}:${PORT}/#invite=${token}"
