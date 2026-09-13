#!/usr/bin/env bash
# Runtime smoke test: starts the real server against a file-backed database and
# drives the real CLI. Complements `npm test` (which runs in-process) by proving
# the thing starts, listens and persists from a cold directory.
#
#   bash scripts/smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${RGM_SMOKE_DIR:-/tmp/rgm-smoke}"
PORT="${RGM_SMOKE_PORT:-3111}"
BASE="http://127.0.0.1:$PORT"

cd "$ROOT"
rm -rf "$RUN"; mkdir -p "$RUN"
export PGLITE_DIR="$RUN/pg"
export STORAGE_DIR="$RUN/storage"
export RGM_CONFIG="$RUN/rgm.json"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

cleanup() { [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

step "migrate"
node src/migrate.js

step "bootstrap the first site admin"
node src/bootstrap.js yuen@example.com

step "start the server"
PORT="$PORT" node src/server.js > "$RUN/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "$BASE/api/health"; echo

step "request a login link (the token is delivered by the default mailer)"
curl -sf -X POST "$BASE/api/auth/request-link" \
  -H 'content-type: application/json' -d '{"email":"yuen@example.com"}'; echo

TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$RUN/server.log" | tail -1 | cut -d= -f2)"
[[ -n "$TOKEN" ]] || { echo "no login token in the server log"; exit 1; }
echo "token: ${TOKEN:0:12}…"

step "consume it and obtain a session"
curl -sf -c "$RUN/cookies" -X POST "$BASE/api/auth/consume" \
  -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}"; echo

# Cookie-authenticated writes now need the CSRF token echoed back in a header —
# this is exactly what public/app.js does. A curl-based script has to do it too.
CSRF="$(grep -w csrf "$RUN/cookies" | awk '{print $7}')"
[[ -n "$CSRF" ]] || { echo "no csrf cookie in the jar"; exit 1; }
echo "csrf token: ${CSRF:0:12}…"

step "a write without the CSRF token is refused"
curl -s -o /dev/null -w 'status without header: %{http_code}\n' \
  -b "$RUN/cookies" -X POST "$BASE/api/projects" \
  -H 'content-type: application/json' -d '{"name":"Nope","client":"X"}'

step "create a project"
PROJECT="$(curl -sf -b "$RUN/cookies" -H "x-csrf-token: $CSRF" -X POST "$BASE/api/projects" \
  -H 'content-type: application/json' \
  -d '{"name":"Packing Line","client":"LWMS"}')"
echo "$PROJECT"
PROJECT_ID="$(printf '%s' "$PROJECT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"

step "mint an API token for the CLI"
APITOKEN="$(curl -sf -b "$RUN/cookies" -H "x-csrf-token: $CSRF" -X POST "$BASE/api/tokens" \
  -H 'content-type: application/json' \
  -d '{"name":"cli","scopes":["bug:read","bug:write"]}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
echo "api token: ${APITOKEN:0:12}…"

step "drive the real CLI"
node src/cli.js login --url "$BASE" --token "$APITOKEN"
node src/cli.js use "$PROJECT_ID"
node src/cli.js projects
node src/cli.js bugs

step "the database persisted across processes"
node -e '
import("./src/db.js").then(async ({ createDb }) => {
  const db = await createDb({ dataDir: process.env.PGLITE_DIR });
  const r = await db.query("SELECT count(*)::int AS c FROM projects");
  const m = await db.query("SELECT count(*)::int AS c FROM schema_migrations");
  console.log(`projects in the on-disk database: ${r.rows[0].c}`);
  console.log(`migrations recorded: ${m.rows[0].c}`);
  await db.close();
});
'

step "OK — server, worker entrypoints and CLI all ran against a real database"
