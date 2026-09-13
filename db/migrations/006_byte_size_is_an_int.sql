-- 006_byte_size_is_an_int.sql — the size of an upload is not a bigint
--
-- `bug_attachments.byte_size` was declared `bigint`. node-postgres returns int8 as
-- a *string*, because a JS number cannot hold every int8 value, so the API sent
-- `"byteSize": "64"` against a real PostgreSQL server and `64` against the
-- embedded driver. The same trap as `count(*)`, but this one is a schema choice
-- rather than a query, so it is fixed here instead of cast at every read.
--
-- Uploads are capped at 8 MB (enforced in the API and by the presign route), so
-- `integer` is the correct type with room to spare.
--
-- Guarded and idempotent: a fresh database from 001 already has `integer`.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'bug_attachments'
       AND column_name = 'byte_size'
       AND data_type = 'bigint'
  ) THEN
    ALTER TABLE bug_attachments ALTER COLUMN byte_size TYPE integer;
    RAISE NOTICE 'bug_attachments.byte_size converted from bigint to integer';
  ELSE
    RAISE NOTICE 'bug_attachments.byte_size is already integer';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'could not convert byte_size (%): %', SQLSTATE, SQLERRM;
END;
$$;

COMMIT;
