#!/bin/bash
# Stop the local server and worker started by dev-up.sh.
set -u

DATA="${RGM_LOCAL_DIR:-$HOME/.rgm-local}"

for role in server worker; do
  PIDFILE="$DATA/$role.pid"
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null
      echo "stopped $role (pid $PID)"
    else
      echo "$role was not running"
    fi
    rm -f "$PIDFILE"
  else
    echo "no $role.pid — not started by dev-up.sh"
  fi
done
