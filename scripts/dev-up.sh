#!/bin/bash
# Start the RGM Project Manager locally (server + worker), with logs on disk.
#
#   bash scripts/dev-up.sh          # start both
#   bash scripts/dev-login.sh       # mint a sign-in link and print it
#   bash scripts/dev-down.sh        # stop both
#
# Everything lives under ~/.rgm-local so it survives restarts:
#   pg/      the database
#   storage/ attachments
#   *.log    server and worker output
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${RGM_LOCAL_DIR:-$HOME/.rgm-local}"
PORT="${PORT:-3000}"

mkdir -p "$DATA/pg" "$DATA/storage"

export PGLITE_DIR="$DATA/pg"
export STORAGE_DIR="$DATA/storage"
export PORT
export PUBLIC_URL="http://127.0.0.1:$PORT"

cd "$HERE"

# Refuse to double-start: a second server would only fail to bind, but a second
# worker would process the same queues.
if [ -f "$DATA/server.pid" ] && kill -0 "$(cat "$DATA/server.pid")" 2>/dev/null; then
  echo "server already running (pid $(cat "$DATA/server.pid")) on $PUBLIC_URL"
  exit 0
fi

nohup node src/server.js > "$DATA/server.log" 2>&1 &
echo $! > "$DATA/server.pid"

nohup node src/worker.js > "$DATA/worker.log" 2>&1 &
echo $! > "$DATA/worker.pid"

for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "$PUBLIC_URL/api/health" 2>/dev/null; then
    echo "up on $PUBLIC_URL  (pids: server $(cat "$DATA/server.pid"), worker $(cat "$DATA/worker.pid"))"
    echo "logs: $DATA/server.log, $DATA/worker.log"
    exit 0
  fi
  sleep 0.5
done

echo "server did not become healthy — see $DATA/server.log" >&2
tail -20 "$DATA/server.log" >&2 || true
exit 1
