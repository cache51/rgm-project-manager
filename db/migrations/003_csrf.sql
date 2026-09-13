-- 003_csrf.sql — CSRF tokens, bound to the session they were issued for
--
-- Cookie authentication is ambient authority: the browser attaches the session
-- cookie to any request any site makes. The defence is a token the attacker's
-- page cannot read, and that is bound to THIS session, so a token minted for one
-- session cannot be replayed against another.
--
-- Existing sessions are revoked: a session with no CSRF binding cannot make
-- state-changing requests, and leaving it half-working is worse than asking the
-- user to sign in again.

BEGIN;

ALTER TABLE sessions ADD COLUMN csrf_hash text;

UPDATE sessions SET revoked_at = now()
 WHERE revoked_at IS NULL;

COMMIT;
