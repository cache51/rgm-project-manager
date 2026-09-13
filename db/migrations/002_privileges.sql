-- 002_privileges.sql — the runtime role, and least privilege on the audit trail
--
-- Closes RGM-017 / RGM-S1-009 and IR-004.
--
-- What this does:
--
--   rgm_runtime   everything the application actually does, EXCEPT that it may
--                 only append to `events`. Rewriting or deleting audit history is
--                 refused by grant as well as by the trigger in 001, so an
--                 application bug — or someone holding the runtime credentials —
--                 cannot alter the trail even if the trigger were dropped.
--   rgm_auditor   read-only, for a person or a report that should never write.
--
-- IR-004 is why this file was rewritten. It previously created a role called
-- `rgm_app` and granted it only `events`, which reads as the application's own
-- role. A deployment that took the name at face value could not query `users`,
-- `sessions` or `active_memberships`, and so could not start — while granting the
-- owner role instead would have thrown away the separation this file exists for.
-- The role now has the grants it needs and the name it deserves.
--
-- Role creation needs CREATEROLE, which a managed Postgres usually withholds from
-- the application's role. Creation is therefore best-effort: the migration
-- succeeds and is recorded either way, logs what it could not do, and an operator
-- can run the DO block as a superuser later. The grants are applied only when the
-- roles exist.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    CREATE ROLE rgm_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_auditor') THEN
    CREATE ROLE rgm_auditor NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'no CREATEROLE: skipping role creation (run this file as a superuser)';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    RAISE NOTICE 'rgm_runtime does not exist: skipping grants';
  ELSE
    BEGIN
      GRANT USAGE ON SCHEMA public TO rgm_runtime;

      -- Everything the application reads and writes today. Granting "all tables"
      -- rather than a list means a migration that adds a table does not silently
      -- produce a runtime role that cannot use it — the failure IR-004 describes.
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rgm_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rgm_runtime;

      -- ...and then take back the one thing the application must never do.
      REVOKE UPDATE, DELETE, TRUNCATE ON events FROM rgm_runtime;

      -- Tables added later belong to whoever runs the next migration; this keeps
      -- the grants true for objects created after this migration too.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rgm_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO rgm_runtime;

      RAISE NOTICE 'granted runtime access; `events` stays append-only';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient privilege to grant on public: skipping';
    END;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_auditor') THEN
    RAISE NOTICE 'rgm_auditor does not exist: skipping grants';
  ELSE
    BEGIN
      GRANT USAGE ON SCHEMA public TO rgm_auditor;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO rgm_auditor;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT ON TABLES TO rgm_auditor;
      RAISE NOTICE 'granted read-only auditing';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient privilege to grant to rgm_auditor: skipping';
    END;
  END IF;
END;
$$;

COMMIT;
