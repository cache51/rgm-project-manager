-- A bug can carry more than pictures.
--
-- The tester's own Excel form, a spec PDF, a CSV export: an agent that asks for one
-- of these could be handed none of them, because this table only ever accepted
-- images. Widening it is one line here, but the picker, the presign check, the
-- completion check and the packet naming had to agree first — a file accepted by one
-- and refused by another is worse than a file refused everywhere.
--
-- The list is explicit rather than a `LIKE 'image/%'` plus exceptions, so it can be
-- read side by side with ALLOWED_UPLOAD_TYPES in src/api.js.
ALTER TABLE bug_attachments DROP CONSTRAINT bug_attachments_content_type_check;
ALTER TABLE bug_attachments ADD CONSTRAINT bug_attachments_content_type_check
  CHECK (content_type IN (
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/heic',
    'application/pdf',
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ));