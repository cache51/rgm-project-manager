#!/bin/bash
# Stop the local server and worker started by dev-up.sh.
#
# Stopping matters more than it looks. The embedded database runs with fsync off and
# keeps a `postmaster.pid` whose pid is a sentinel (-42), not a real process. If the
# server is killed while that file exists, the next start finds it and refuses to
# initialise — the process spins at 100% CPU and writes nothing to its log, which looks
# exactly like a hang. So: ask nicely, wait for it to actually exit, and only then
# clear a sentinel that nothing holds.
set -u

DATA="${RGM_LOCAL_DIR:-$HOME/.rgm-local}"
GRACE="${DEV_DOWN_GRACE:-10}"

stop_one() {
  local role="$1" PIDFILE="$DATA/$1.pid"
  if [ ! -f "$PIDFILE" ]; then
    echo "no $role.pid — not started by dev-up.sh"
    return
  fi

  local pid; pid="$(cat "$PIDFILE")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$role was not running"
    rm -f "$PIDFILE"
    return
  fi

  kill "$pid" 2>/dev/null
  # Wait for the process to actually go, rather than assuming the signal landed.
  for _ in $(seq 1 "$GRACE"); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "$role (pid $pid) ignored SIGTERM; killing"
    kill -9 "$pid" 2>/dev/null
    sleep 1
  fi
  echo "stopped $role (pid $pid)"
  rm -f "$PIDFILE"
}

for role in server worker; do stop_one "$role"; done

# Clear the embedded database's sentinel only when no process holds the directory.
PGDIR="$DATA/pg"
if [ -f "$PGDIR/postmaster.pid" ]; then
  if [ -z "$(lsof +D "$PGDIR" 2>/dev/null | awk 'NR>1 {print $2}' | head -1)" ]; then
    rm -f "$PGDIR/postmaster.pid"
    echo "cleared a stale postmaster.pid (nothing was holding the database)"
  else
    echo "postmaster.pid left alone — a process still holds $PGDIR"
  fi
fi
