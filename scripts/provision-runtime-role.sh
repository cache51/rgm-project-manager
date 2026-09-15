#!/bin/sh
set -eu

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${RGM_RUNTIME_PASSWORD:?RGM_RUNTIME_PASSWORD is required}"

export PGPASSWORD=$POSTGRES_PASSWORD
psql --host=db --username=rgm --dbname=rgm --set=ON_ERROR_STOP=1 \
  --set=runtime_password="$RGM_RUNTIME_PASSWORD" <<'SQL'
DO $provision$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_app') THEN
    CREATE ROLE rgm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$provision$;

ALTER ROLE rgm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'runtime_password';
GRANT rgm_runtime TO rgm_app;
SQL
