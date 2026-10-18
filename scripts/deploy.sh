#!/usr/bin/env bash
#
# Deploy a known commit onto this host — the one command the deployment is.
#
#   ./scripts/deploy.sh                    # deploy origin/main
#   DEPLOY_REF=<sha> ./scripts/deploy.sh   # deploy exactly that commit (what CI sends)
#
# Safe to re-run after any failure: migrate is additive, and `compose up` only
# recreates what changed. A second concurrent deploy is refused, not interleaved.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "no .env beside docker-compose.yml — see README, section Configuration" >&2
  exit 1
fi

# One deploy at a time: two pulls racing over the same checkout and the same
# volumes is how a "successful" deploy ends up running the other one's code.
exec 9>deploy.lock
if ! flock -n 9; then
  echo "another deploy is already running on this host" >&2
  exit 1
fi

REF="${DEPLOY_REF:-origin/main}"
git fetch --quiet origin
git checkout --quiet "$REF"
echo "deploying $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"

docker compose build --quiet
# The chain inside compose does the ordering: migrate runs and completes,
# the runtime role is provisioned, only then do app and worker start.
docker compose up -d --wait

# `--wait` can be satisfied the moment the app container reports healthy;
# the first request can still race startup. Poll the real endpoint.
ENDPOINT="$(docker compose port app 3000 2>/dev/null || echo 127.0.0.1:3000)"
for _ in $(seq 1 30); do
  if curl -fsS "http://${ENDPOINT}/api/health" >/dev/null 2>&1; then
    echo "deployed: $(curl -fsS "http://${ENDPOINT}/api/health")"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

echo "app never passed /api/health within 60s — last 50 lines:" >&2
docker compose logs --tail=50 app >&2
exit 1
