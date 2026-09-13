-- 007_invitation_name.sql — let an invitation carry the person's name
--
-- `users.display_name` was derived from the email address (the part before the @), so
-- a project with three testers at one company showed "test01", "qa.linh" and
-- "warehouse2" — and an admin reading a report could not tell who reported it.
--
-- The name is given when the person is invited, which is the moment the inviter knows
-- who they are. It is nullable: an invitation without a name still works and falls
-- back to the old derivation, so this changes nothing for existing rows.

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS display_name text;

COMMENT ON COLUMN invitations.display_name IS
  'The invitee''s name, used as their user display_name when they redeem. NULL falls back to the email local part.';
