#!/bin/bash
# Mint a sign-in link for a local account and print it.
#
# The mailer is the console one in local development, so the link goes to
# server.log rather than to an inbox. Usage:
#
#   bash scripts/dev-login.sh                 # uses the bootstrapped admin
#   bash scripts/dev-login.sh someone@x.test
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${RGM_LOCAL_DIR:-$HOME/.rgm-local}"
PORT="${PORT:-3000}"
EMAIL="${1:-yuen.chan@gmail.com}"
LOG="$DATA/server.log"

if [ ! -f "$LOG" ]; then
  echo "no server log at $LOG — run: bash scripts/dev-up.sh" >&2
  exit 1
fi

# Note the line count first, so an older link earlier in the log cannot be
# mistaken for the one we are about to request.
BEFORE=$(wc -l < "$LOG" | tr -d ' ')

curl -fsS -X POST "http://127.0.0.1:$PORT/api/auth/request-link" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\"}" > /dev/null

for _ in $(seq 1 30); do
  LINK=$(tail -n "+$((BEFORE + 1))" "$LOG" | grep -oE 'http://[^ ]*/login\?token=[A-Za-z0-9_-]+' | tail -1 || true)
  if [ -n "$LINK" ]; then
    echo "$LINK"
    exit 0
  fi
  sleep 0.2
done

echo "no link appeared in $LOG — check that the server is running" >&2
exit 1
