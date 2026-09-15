-- 011_admin_audit_append_only.sql — make purge tombstones immutable
--
-- The operator audit survives project deletion by design. Protect it independently
-- from application bugs and runtime credentials: the runtime may read records but
-- only the one-shot owner purge function may append them.

CREATE FUNCTION admin_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_no_update
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_append_only();

CREATE TRIGGER admin_audit_no_truncate
  BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    GRANT SELECT ON admin_audit_log TO rgm_runtime;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON admin_audit_log FROM rgm_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_auditor') THEN
    GRANT SELECT ON admin_audit_log TO rgm_auditor;
  END IF;
END;
$$;
