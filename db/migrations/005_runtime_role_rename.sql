-- 005_runtime_role_rename.sql — `rgm_app` was the wrong name for what it was
--
-- Closes IR-004 for installations that already applied the old 002.
--
-- That version created a role called `rgm_app` and granted it only `events`, which
-- reads as the application's runtime role. Anyone who used it as one found they
-- could not query `users`, `sessions` or `active_memberships`. 002 now creates
-- `rgm_runtime` with the grants the application actually needs; this migrates an
-- existing installation to the same state.
--
-- Roles are cluster-scoped while grants are per-database, so this must not assume
-- it is the only database on the cluster:
--
--   * only `rgm_app` exists  → rename it (the normal upgrade path)
--   * both exist             → revoke the old role's access here and drop it if
--                              the cluster will let us; if another database still
--                              depends on it, leave it and say so. A migration
--                              that cannot drop a stale role must not fail: the
--                              stale role is inert, and failing would break every
--                              deployment that has one.
--
-- Every step is best-effort and reports what it could not do. Idempotent.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_app') THEN
    RAISE NOTICE 'no rgm_app to migrate';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    BEGIN
      ALTER ROLE rgm_app RENAME TO rgm_runtime;
      RAISE NOTICE 'renamed rgm_app to rgm_runtime';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'could not rename rgm_app (%), leaving it in place', SQLERRM;
    END;
    RETURN;
  END IF;

  -- Both exist: the old role is superseded. Take its access away here first, so
  -- that even if it cannot be dropped it can no longer reach this database's data.
  BEGIN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rgm_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rgm_app;
    REVOKE ALL ON SCHEMA public FROM rgm_app;
    RAISE NOTICE 'revoked rgm_app''s access in this database';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'could not revoke from rgm_app (%): %', SQLSTATE, SQLERRM;
  END;

  BEGIN
    DROP ROLE rgm_app;
    RAISE NOTICE 'dropped the superseded rgm_app role';
  EXCEPTION WHEN OTHERS THEN
    -- Almost always "role cannot be dropped because some objects depend on it",
    -- i.e. another database on this cluster still grants to it. Not our call to
    -- make from here, and certainly not a reason to fail the migration.
    RAISE NOTICE 'keeping rgm_app: it is still referenced elsewhere on this cluster';
  END;
END;
$$;

-- Whatever route we arrived by, the role the application uses must be able to do
-- the application's work — while `events` stays append-only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    BEGIN
      GRANT USAGE ON SCHEMA public TO rgm_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rgm_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rgm_runtime;
      REVOKE UPDATE, DELETE, TRUNCATE ON events FROM rgm_runtime;
      RAISE NOTICE 'applied runtime grants to rgm_runtime';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'could not grant to rgm_runtime (%): %', SQLSTATE, SQLERRM;
    END;
  END IF;
END;
$$;

COMMIT;
