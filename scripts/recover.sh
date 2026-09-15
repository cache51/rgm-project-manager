#!/bin/bash
# Recover the RGM PostgreSQL database from a pg_dump custom archive.
# The live database is untouched until the exact current-schema, filtered restore
# has succeeded in a disposable validation database.
set -Eeuo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/recover.sh SNAPSHOT.dump --confirm-drop-database rgm \
    [--actor-email SITE_ADMIN_EMAIL --keep-project UUID ...]
USAGE
}

SNAPSHOT=${1:-}
[ -n "$SNAPSHOT" ] || { usage; exit 2; }
shift
CONFIRM=""
ACTOR_EMAIL=""
KEEP_IDS=()
KEEP_COUNT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm-drop-database)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      CONFIRM=$2; shift 2 ;;
    --keep-project)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      KEEP_IDS+=("$2"); KEEP_COUNT=$((KEEP_COUNT + 1)); shift 2 ;;
    --actor-email)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      ACTOR_EMAIL=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

DB=rgm
OWNER=rgm
if [ "$CONFIRM" != "$DB" ]; then
  echo "refusing recovery: pass --confirm-drop-database rgm exactly" >&2
  exit 2
fi
[ -s "$SNAPSHOT" ] || { echo "snapshot is missing or empty: $SNAPSHOT" >&2; exit 2; }
if [ "$KEEP_COUNT" -gt 0 ]; then
  [ -n "$ACTOR_EMAIL" ] || {
    echo "--keep-project needs --actor-email <site-admin-email>" >&2; exit 2;
  }
  for id in "${KEEP_IDS[@]}"; do
    [[ "$id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || {
      echo "bad project UUID: $id" >&2; exit 2;
    }
  done
fi

RUN_ID=$$
COMPOSE_PROJECT=${RGM_COMPOSE_PROJECT:-rgm}
[[ "$COMPOSE_PROJECT" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo "bad Compose project name: $COMPOSE_PROJECT" >&2; exit 2;
}
LOCK_DIR="/tmp/rgm-recover-${COMPOSE_PROJECT}-${DB}.lock"
DUMP_IN_CONTAINER="/tmp/rgm-recover-${RUN_ID}.dump"
RAW_TOC="/tmp/rgm-recover-${RUN_ID}.raw.list"
FILTERED_TOC="/tmp/rgm-recover-${RUN_ID}.list"
VALIDATION_DB="rgm_restore_check_${RUN_ID}"
VALIDATION_CREATED=0
ARTIFACTS_PRESENT=0
LOCK_HELD=0
DB_READY_ATTEMPTS=${RGM_DB_READY_ATTEMPTS:-30}
DB_READY_DELAY=${RGM_DB_READY_DELAY:-1}

compose() { docker compose -p "$COMPOSE_PROJECT" "$@"; }

wait_for_database() {
  attempt=1
  while [ "$attempt" -le "$DB_READY_ATTEMPTS" ]; do
    if compose exec -T db pg_isready -U "$OWNER" -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep "$DB_READY_DELAY"
    attempt=$((attempt + 1))
  done
  echo "FATAL: database did not become ready" >&2
  return 1
}

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  cleanup_failed=0
  if [ "$VALIDATION_CREATED" -eq 1 ]; then
    compose exec -T db psql -U "$OWNER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$VALIDATION_DB\" WITH (FORCE);" >/dev/null 2>&1 || {
      echo "FATAL: could not remove validation database $VALIDATION_DB" >&2
      cleanup_failed=1
    }
  fi
  if [ "$ARTIFACTS_PRESENT" -eq 1 ]; then
    compose exec -T db rm -f "$DUMP_IN_CONTAINER" "$RAW_TOC" "$FILTERED_TOC" \
      >/dev/null 2>&1 || {
      echo "FATAL: could not remove recovery artifacts from database container" >&2
      cleanup_failed=1
    }
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
  if [ "$rc" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then rc=1; fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another RGM recovery is already running ($LOCK_DIR)" >&2
  exit 3
fi
LOCK_HELD=1

if [ "$KEEP_COUNT" -gt 0 ]; then
  KEEP_SQL=""
  for id in "${KEEP_IDS[@]}"; do
    [ -z "$KEEP_SQL" ] || KEEP_SQL+=","
    KEEP_SQL+="'$id'::uuid"
  done
fi

step() { printf '\n== %s ==\n' "$1"; }

migrate_database() {
  target=$1
  if [ "$target" = "$DB" ]; then
    compose run --rm -T --no-deps migrate
  else
    compose run --rm -T --no-deps -e RGM_RECOVER_DB="$target" migrate sh -ec \
      'export DATABASE_URL="${DATABASE_URL%/*}/$RGM_RECOVER_DB"; exec node src/migrate.js'
  fi
}

restore_data() {
  target=$1
  if compose exec -T db pg_restore -U "$OWNER" -d "$target" \
    --no-owner --role="$OWNER" --data-only --disable-triggers \
    --use-list="$FILTERED_TOC" --exit-on-error "$DUMP_IN_CONTAINER"; then
    return 0
  else
    rc=$?
    echo "FATAL: pg_restore failed with status $rc; application remains stopped" >&2
    return "$rc"
  fi
}

apply_allow_list() {
  target=$1
  [ "$KEEP_COUNT" -gt 0 ] || return 0

  matched=$(compose exec -T db psql -U "$OWNER" -d "$target" -At -v ON_ERROR_STOP=1 \
    -c "SELECT count(*)::int FROM projects WHERE id IN ($KEEP_SQL);")
  if [ "$matched" != "$KEEP_COUNT" ]; then
    echo "requested keep-project UUID was not found in the restored snapshot" >&2
    return 4
  fi

  compose exec -T db psql -U "$OWNER" -d "$target" -v ON_ERROR_STOP=1 \
    -v actor_email="$ACTOR_EMAIL" <<SQL
BEGIN;
SELECT set_config(
  'rgm.recovery_actor_email',
  lower(:'actor_email'),
  true
);
DO \$purge\$
DECLARE
  actor_email text;
  item record;
BEGIN
  actor_email := current_setting('rgm.recovery_actor_email');
  IF actor_email = '' THEN
    RAISE EXCEPTION 'recovery actor email is required';
  END IF;
  IF EXISTS (SELECT 1 FROM projects WHERE id NOT IN ($KEEP_SQL)) THEN
    FOR item IN SELECT id FROM projects WHERE id NOT IN ($KEEP_SQL) ORDER BY id LOOP
      PERFORM * FROM admin_purge_project(
        actor_email, item.id, 'recovery allow-list excluded project', true);
    END LOOP;
  END IF;
END
\$purge\$;
COMMIT;
SQL

  retained=$(compose exec -T db psql -U "$OWNER" -d "$target" -At -v ON_ERROR_STOP=1 \
    -c "SELECT count(*)::int FROM projects;")
  if [ "$retained" != "$KEEP_COUNT" ]; then
    echo "allow-list pruning retained an unexpected project count" >&2
    return 4
  fi
}

remove_artifacts() {
  compose exec -T db rm -f "$DUMP_IN_CONTAINER" "$RAW_TOC" "$FILTERED_TOC"
  ARTIFACTS_PRESENT=0
}

step "preflight exact restore before any destructive action"
DB_RUNNING=$(compose ps --status running --services db)
if [ "$DB_RUNNING" != "db" ]; then
  compose up -d db
fi
wait_for_database
compose cp "$SNAPSHOT" "db:$DUMP_IN_CONTAINER"
ARTIFACTS_PRESENT=1
set +e
compose exec -T db sh -ec "
  pg_restore -l '$DUMP_IN_CONTAINER' > '$RAW_TOC'
  while IFS= read -r line; do
    case \"\$line\" in
      *\" TABLE DATA \"*\" schema_migrations \"*) printf \";%s\\n\" \"\$line\" ;;
      *) printf \"%s\\n\" \"\$line\" ;;
    esac
  done < '$RAW_TOC' > '$FILTERED_TOC'
"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "FATAL: cannot read snapshot TOC (status $rc); live database was not touched" >&2
  exit "$rc"
fi

compose exec -T db psql -U "$OWNER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$VALIDATION_DB\" OWNER \"$OWNER\";"
VALIDATION_CREATED=1
migrate_database "$VALIDATION_DB"
if restore_data "$VALIDATION_DB"; then
  :
else
  rc=$?
  echo "FATAL: exact full snapshot validation failed; live database was not touched" >&2
  exit "$rc"
fi
apply_allow_list "$VALIDATION_DB"
if ! compose exec -T db psql -U "$OWNER" -d "$VALIDATION_DB" -At -v ON_ERROR_STOP=1 \
  -c "SELECT 1 FROM schema_migrations LIMIT 1;" | grep -qx 1; then
  echo "FATAL: validation database is not usable" >&2
  exit 5
fi
set +e
compose exec -T db psql -U "$OWNER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$VALIDATION_DB\" WITH (FORCE);"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "FATAL: could not remove validation database $VALIDATION_DB" >&2
  exit "$rc"
fi
VALIDATION_CREATED=0

step "stop application writers"
compose stop app worker

step "recreate database and migrate current schema"
compose exec -T db psql -U "$OWNER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$DB\" OWNER \"$OWNER\";"
migrate_database "$DB"

step "restore the same filtered data path proven by preflight"
restore_data "$DB"
apply_allow_list "$DB"

step "delete persisted objects for allow-list exclusions or earlier failed purges"
compose run --rm -T --no-deps recover-admin

step "provision non-owner logins and restart application"
compose run --rm -T --no-deps runtime-role
compose up -d app worker

HEALTH_URL=${RGM_HEALTH_URL:-http://127.0.0.1:${APP_PORT:-3000}/api/health}
HEALTH_ATTEMPTS=${RGM_HEALTH_ATTEMPTS:-30}
HEALTH_DELAY=${RGM_HEALTH_DELAY:-2}
if [ -n "$HEALTH_URL" ]; then
  healthy=0
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; then
      healthy=1; break
    fi
    [ "$attempt" -eq "$HEALTH_ATTEMPTS" ] || sleep "$HEALTH_DELAY"
  done
  if [ "$healthy" -ne 1 ]; then
    echo "FATAL: health check failed after $HEALTH_ATTEMPTS attempts: $HEALTH_URL" >&2
    exit 1
  fi
fi

# The service startup check verifies both runtime and purge pools. This owner-side
# query additionally proves the restored database can execute ordinary SQL.
compose exec -T db psql -U "$OWNER" -d "$DB" -At -v ON_ERROR_STOP=1 \
  -c "SELECT 1 FROM schema_migrations LIMIT 1;" | grep -qx 1
remove_artifacts
compose ps
step "recovery complete"
