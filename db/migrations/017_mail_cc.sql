-- 017: one mail per bug event, with the rest of the audience on Cc.
--
-- The outbox inserted one row per recipient, so a bug question with three
-- people who should hear about it produced three separate emails — three
-- copies in every mailbox, none showing the others were told. One addressed
-- mail per event: To: the person who must act (the reporter), Cc: everyone
-- else who cares. Membership is still re-checked at delivery for every named
-- user (RGM3-010): a removed member drops out of the Cc list, or cancels the
-- mail outright when they were the primary. Milestone readiness mail is left
-- one-per-tester on purpose: there the audience is homogeneous (every tester
-- is a primary), and collapsing it would let one removed tester cancel the
-- others' notice.
--
-- cc_recipients holds [{"userId":uuid,"email":text} | "email"] — a user id
-- when the person has an account (so delivery can re-check them), a bare
-- address otherwise. Old rows carry the default '[]' and still deliver.
ALTER TABLE notifications_outbox
  ADD COLUMN IF NOT EXISTS cc_recipients jsonb NOT NULL DEFAULT '[]'::jsonb;
