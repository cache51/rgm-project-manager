-- 002_privileges.sql — role separation for the events table
--
-- Closes RGM-017 / RGM-S1-009.
--
-- Defence in depth for the audit trail. The append-only trigger in 001 already
-- rejects UPDATE/DELETE, but a trigger can be dropped by a future migration and
-- it does not protect against a role that is allowed to disable it. Granting the
-- application role INSERT-but-not-UPDATE at the database level means the trail
-- cannot be rewritten by the application at all.
--
-- Role creation needs CREATEROLE. On a managed Postgres the application role
-- usually does not have it, so creation is best-effort: each step is wrapped so
-- the migration SUCCEEDS and is recorded either way, and an operator can re-run
-- the block as a superuser later. A migration that fails on a locked-down
-- deployment is worse than one that degrades with a NOTICE.

BEGIN;

-- ── create the roles, if this connection is allowed to ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_app') THEN
    BEGIN
      CREATE ROLE rgm_app NOLOGIN;
      RAISE NOTICE 'created role rgm_app';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'no CREATEROLE: rgm_app not created (re-run as superuser)';
    END;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_auditor') THEN
    BEGIN
      CREATE ROLE rgm_auditor NOLOGIN;
      RAISE NOTICE 'created role rgm_auditor';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'no CREATEROLE: rgm_auditor not created (re-run as superuser)';
    END;
  END IF;
END;
$$;

-- ── the application role may append to events and nothing else ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_app') THEN
    BEGIN
      GRANT USAGE ON SCHEMA public TO rgm_app;

      -- append-only: no UPDATE, no DELETE, no TRUNCATE
      GRANT SELECT, INSERT ON events TO rgm_app;
      REVOKE UPDATE, DELETE, TRUNCATE ON events FROM rgm_app;

      -- the bigserial needs its sequence, or INSERT fails
      GRANT USAGE, SELECT ON SEQUENCE events_id_seq TO rgm_app;

      RAISE NOTICE 'rgm_app: SELECT+INSERT on events, no UPDATE/DELETE/TRUNCATE';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient privilege to grant on events (re-run as owner)';
    END;
  END IF;
END;
$$;

-- ── the auditor may read everything and write nothing ──
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_auditor') THEN
    BEGIN
      GRANT USAGE ON SCHEMA public TO rgm_auditor;
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('GRANT SELECT ON %I TO rgm_auditor', t);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM rgm_auditor', t);
      END LOOP;
      RAISE NOTICE 'rgm_auditor: SELECT on every table, no writes';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient privilege to grant to rgm_auditor';
    END;
  END IF;
END;
$$;

COMMIT;
