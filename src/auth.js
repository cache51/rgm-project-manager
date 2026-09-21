/**
 * Authentication and authorization.
 *
 * Two rules from the plan are enforced structurally here:
 *
 *   §1 / RGM-011  Every request resolves an actor and the TARGET resource's
 *                 project, then requires an ACTIVE membership. `activeMembership`
 *                 is the only function that answers "is this actor a member" and it
 *                 hard-codes `revoked_at IS NULL`, so a revoked row can never
 *                 satisfy it.
 *
 *   §4 / RGM-013  Invitations and login are separate flows. An invitation grants
 *                 membership; it never creates a session. Redemption does not log
 *                 anyone in — the invitee then requests a login link.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { withTransaction } from './db.js';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const normalizeEmail = (e) => String(e ?? '').trim().toLowerCase();

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const ROLES = Object.freeze(['admin', 'developer', 'tester']);

// ───────────────────────── authorization ─────────────────────────

/** The ONLY definition of "is this actor a member of this project". */
export async function activeMembership(db, userId, projectId) {
  const r = await db.query(
    'SELECT role FROM active_memberships WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]);
  return r.rows[0]?.role ?? null;
}

/**
 * Assert a project has not been removed.
 *
 * A removed project is not a live target: nothing may be read or written through it.
 * 410 Gone rather than 403, because "forbidden" sends the reader looking for a
 * permissions problem that is not there.
 */
export async function requireLiveProject(db, projectId) {
  const r = await db.query('SELECT deleted_at FROM projects WHERE id = $1', [projectId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'project not found');
  if (r.rows[0].deleted_at) {
    throw new HttpError(410, 'project_removed', 'this project was removed');
  }
}

/**
 * Resolve the actor's effective role in a project and assert it is sufficient.
 * A site admin acts with admin authority anywhere, but still needs an active
 * membership to reach project data (RGM-S1-004).
 *
 * A removed project is refused even for its own members — that is what removal means.
 * Restoring one therefore cannot come through here; see `authorizeRemovedProject`.
 */
export async function authorize(db, actor, projectId, allowed = ROLES) {
  if (!actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
  const role = await activeMembership(db, actor.userId, projectId);
  if (!role) throw new HttpError(403, 'not_a_member', 'not a member of this project');
  await requireLiveProject(db, projectId);
  const effective = actor.isSiteAdmin ? 'admin' : role;
  if (!allowed.includes(effective)) {
    throw new HttpError(403, 'forbidden', `requires ${allowed.join(' or ')}`);
  }
  return effective;
}

/**
 * Authorize an action on a project that is *not* live.
 *
 * `authorize` refuses removed projects on purpose, so restoring is the one thing that
 * cannot go through it. The membership test is otherwise identical — deliberately, so
 * this is not a weaker door: you still have to be an admin on the project to bring it
 * back.
 */
export async function authorizeRemovedProject(db, actor, projectId, allowed = ['admin']) {
  if (!actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
  const role = await activeMembership(db, actor.userId, projectId);
  if (!role) throw new HttpError(403, 'not_a_member', 'not a member of this project');
  const effective = actor.isSiteAdmin ? 'admin' : role;
  if (!allowed.includes(effective)) {
    throw new HttpError(403, 'forbidden', `requires ${allowed.join(' or ')}`);
  }
  return effective;
}

/**
 * Re-assert the actor's authority from inside the mutation's transaction.
 *
 * `authorize()` runs before the request body is read, so authority can be revoked
 * in between: an admin can open a PATCH, be demoted while the body is still in
 * flight, and then have the request complete with the rights they no longer hold —
 * including restoring their own role (RGM4-001). This mirrors `authorize` exactly,
 * including the site-admin bypass, but reads through the transaction that holds the
 * project lock.
 */
export async function requireActorAuthority(tx, actor, projectId, allowed = ROLES) {
  if (!actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
  const r = await tx.query(
    `SELECT role FROM active_memberships WHERE project_id = $1 AND user_id = $2`,
    [projectId, actor.userId]);
  const role = r.rows[0]?.role;
  if (!role) throw new HttpError(403, 'not_a_member', 'not a member of this project');
  const effective = actor.isSiteAdmin ? 'admin' : role;
  if (!allowed.includes(effective)) {
    throw new HttpError(403, 'forbidden',
      `requires ${allowed.join(' or ')} — your role changed while this request was in flight`);
  }
  return effective;
}

/** Resolve the project a bug belongs to, then authorize against it. */
export async function authorizeBug(db, actor, bugId, allowed = ROLES) {
  const r = await db.query('SELECT id, project_id, deleted_at FROM bugs WHERE id = $1', [bugId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'bug not found');
  if (r.rows[0].deleted_at) {
    throw new HttpError(410, 'bug_removed', 'this bug was removed');
  }
  const role = await authorize(db, actor, r.rows[0].project_id, allowed);
  return { projectId: r.rows[0].project_id, role };
}

export async function authorizeMilestone(db, actor, milestoneId, allowed = ROLES) {
  const r = await db.query(
    'SELECT id, project_id, deleted_at FROM milestones WHERE id = $1', [milestoneId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'milestone not found');
  if (r.rows[0].deleted_at) {
    throw new HttpError(410, 'milestone_removed', 'this milestone was removed');
  }
  const role = await authorize(db, actor, r.rows[0].project_id, allowed);
  return { projectId: r.rows[0].project_id, role };
}

// ───────────────────────── login (§4) ─────────────────────────

/**
 * Issue a login link. Always resolves to `{ sent }` without revealing whether the
 * address exists — the caller must return an identical response either way.
 *
 * Delivery happens out of band: the response never waits on the mailer, and a
 * mailer failure is logged rather than surfaced, because both would let an
 * unauthenticated caller distinguish a known address from an unknown one by
 * timing or by error (IR-019).
 */
export async function requestLoginLink(db, rawEmail,
    { deliver, ttlMinutes = 15, ip = null, onDeliveryError = null,
      defer = setImmediate } = {}) {
  const email = normalizeEmail(rawEmail);
  const u = await db.query('SELECT id, email, is_site_admin FROM users WHERE email = $1', [email]);
  if (!u.rows.length) return { sent: false };

  const user = u.rows[0];
  // A bootstrapped site admin must be able to sign in before any project exists
  // (RGM3-007 / RGM3-003), so membership is not the only way in.
  const hasMembership = (await db.query(
    'SELECT 1 FROM active_memberships WHERE user_id = $1 LIMIT 1', [user.id])).rows.length > 0;
  if (!user.is_site_admin && !hasMembership) return { sent: false };

  const token = newToken();
  await db.query(
    `INSERT INTO login_tokens (user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, now() + make_interval(mins => $3::int), $4)`,
    [user.id, hashToken(token), ttlMinutes, ip]);

  if (deliver) {
    // The caller's promise is "a link was requested", not "the mail left the
    // building". `defer` decides when delivery may start — the HTTP route
    // schedules it after the response has closed, so not even the mailer's
    // SYNCHRONOUS prefix (message building, socket setup) shares the response's
    // event-loop turn; a known address must not cost measurably more than an
    // unknown one. Everything is terminal: a synchronous throw must not escape,
    // and a failing reporter must not become an unhandled rejection (IR-019).
    defer(() => {
      void (async () => {
        try {
          await deliver({ to: email, token, kind: 'login' });
        } catch (err) {
          try {
            // Awaited, not just called: a reporter may itself be async, and a
            // rejected reporter promise must be caught here, not floating.
            await (onDeliveryError
              ?? ((e) => console.error('[login-link delivery failed]', e.message)))(err);
          } catch (reporterErr) {
            console.error('[login-link delivery] error reporter failed', reporterErr);
          }
        }
      })();
    });
  }
  return { sent: true };
}

/** Consume a login token and mint a session. Single-use, atomic. */
export async function consumeLoginToken(db, token, { absoluteDays = 30 } = {}) {
  const claimed = await db.query(
    `UPDATE login_tokens SET consumed_at = now()
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id`, [hashToken(token)]);
  if (!claimed.rows.length) return null;

  return mintSession(db, claimed.rows[0].user_id, { absoluteDays });
}

/**
 * Start a session for a user.
 *
 * The CSRF secret is returned once, to be set as a readable cookie. Only its hash is
 * stored, and it is bound to this session.
 */
export async function mintSession(db, userId, { absoluteDays = 30 } = {}) {
  const sessionToken = newToken();
  const csrfToken = newToken();
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_hash, absolute_expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4::int))`,
    [userId, hashToken(sessionToken), hashToken(csrfToken), absoluteDays]);

  return { userId, sessionToken, csrfToken };
}

/**
 * Sign in with an email address alone.
 *
 * This deployment is an internal tool with no mailer, so the one-time-link flow meant
 * reading a link out of the server console — unusable for the testers it was meant to
 * serve, and the reason every sign-in needed a hand. A session is opened for whatever
 * address is given, and the role comes from the membership an admin already recorded.
 *
 * The tradeoff is deliberate and worth stating plainly: this cannot tell two people
 * apart beyond the address each types, so the audit trail records the address someone
 * *claimed*, not one they proved. That is acceptable for a trusted internal tool; it
 * would not be on the public internet.
 */
export async function directSignIn(db, email, { absoluteDays = 30 } = {}) {
  const normalized = normalizeEmail(email);
  const u = await db.query('SELECT id FROM users WHERE email = $1', [normalized]);
  if (!u.rows.length) return null;      // only addresses an admin has added may enter
  return mintSession(db, u.rows[0].id, { absoluteDays });
}

/** Resolve a session cookie. Idle timeout is enforced here, not by a cron. */
export async function resolveSession(db, sessionToken, { idleHours = 12 } = {}) {
  if (!sessionToken) return null;
  const r = await db.query(
    `SELECT s.id, s.user_id, s.csrf_hash, u.email, u.is_site_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.absolute_expires_at > now()
        AND s.last_seen_at > now() - make_interval(hours => $2::int)`,
    [hashToken(sessionToken), idleHours]);
  if (!r.rows.length) return null;

  const row = r.rows[0];
  await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
  return { sessionId: row.id, userId: row.user_id, email: row.email,
           isSiteAdmin: row.is_site_admin, via: 'session',
           csrfHash: row.csrf_hash ?? null };
}

/**
 * Verify a double-submit CSRF token against the session it must belong to.
 *
 * Two things have to hold, and neither is sufficient alone: the caller must have
 * read the cookie (so it is not a cross-site request), and the token must be the
 * one issued to THIS session (so a leaked token from another session is useless).
 * A session with no recorded hash — one predating the migration — fails closed.
 */
export function verifyCsrfToken(actor, presented) {
  if (actor?.via !== 'session') return true;   // bearer tokens are not ambient
  if (!actor.csrfHash) return false;           // fails closed
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(hashToken(presented));
  const b = Buffer.from(actor.csrfHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function revokeSession(db, sessionToken) {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(sessionToken)]);
}

/** Revoke every session for one user (used when an account is disabled). */
export async function revokeAllSessions(db, userId) {
  const r = await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
    [userId]);
  return r.rows.length;
}

// ─────────────────── machine credentials (§10) ───────────────────

export async function mintApiToken(db, userId, { name, scopes, days = 90 }) {
  const token = newToken();
  const r = await db.query(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int))
     RETURNING id, name, scopes, expires_at`,
    [userId, name, hashToken(token), scopes, days]);
  // The plaintext is returned exactly once, at creation.
  return { ...r.rows[0], token };
}

export async function resolveApiToken(db, token) {
  if (!token) return null;
  const r = await db.query(
    `SELECT t.id, t.user_id, t.scopes, u.email, u.is_site_admin
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()`,
    [hashToken(token)]);
  if (!r.rows.length) return null;
  await db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [r.rows[0].id]);
  return { tokenId: r.rows[0].id, userId: r.rows[0].user_id, scopes: r.rows[0].scopes,
           email: r.rows[0].email, isSiteAdmin: r.rows[0].is_site_admin, via: 'api_token' };
}

export async function revokeApiToken(db, userId, tokenId) {
  const r = await db.query(
    `UPDATE api_tokens SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`, [tokenId, userId]);
  return r.rows.length > 0;
}

// Scopes are enforced centrally, from the route policy in api.js — see
// SCOPE_POLICY there. Keeping a second per-call-site helper was how three routes
// came to be checked and thirty were not (IR-001).

// ─────────────────── invitations (§5) ───────────────────

export async function createInvite(db, { projectId, email, role, actor, name, deliver,
                                        ttlHours = 72 }) {
  if (!ROLES.includes(role)) throw new HttpError(400, 'bad_role', `unknown role ${role}`);
  const normalized = normalizeEmail(email);
  const token = newToken();

  await withTransaction(db, async (tx) => {
    // The same per-(project,email) lock that redemption and removal take, so a
    // creation cannot commit after a removal and restore the access it just
    // revoked. Redemption and removal had it; creation did not (RGM3-003).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`invite:${projectId}:${normalized}`]);

    // And the actor is re-checked under that lock, because `authorize()` ran before
    // the body was read (RGM4-001).
    await requireActorAuthority(tx, actor, projectId, ['admin']);

    // Retire anything expired first. The live-invitation index excludes consumed
    // and revoked rows but cannot exclude by expiry — `now()` is not immutable, so
    // it cannot appear in a partial index predicate. An invitation nobody redeemed
    // therefore kept the next one un-issuable for that address for ever (IR-016).
    await tx.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE project_id = $1 AND email = $2 AND consumed_at IS NULL
          AND revoked_at IS NULL AND expires_at <= now()`,
      [projectId, normalized]);

    await tx.query(
      `INSERT INTO invitations
         (project_id, email, role, token_hash, expires_at, created_by, display_name)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int), $6, $7)`,
      [projectId, normalized, role, hashToken(token), ttlHours, actor.userId,
       name?.trim() || null]);
  });

  if (deliver) await deliver({ to: normalized, token, kind: 'invite' });
  return { sent: true };
}

/**
 * Put someone on a project: an email, a name and a role, applied immediately.
 *
 * This replaces the invitation flow for this deployment. An invitation was a secret
 * that had to be delivered to be useful; there is no mailer here, so the token only
 * ever travelled through the server console — which is the machinery being removed.
 * Recording the mapping directly reaches the same state without the intermediate
 * secret, and an admin adding someone is the same act either way.
 *
 * Reuses the invitation lock and the actor re-check, so adding someone cannot race a
 * removal or land on authority the caller has since lost.
 */
export async function addMember(db, { projectId, email, name, role, actor }) {
  if (!ROLES.includes(role)) throw new HttpError(400, 'bad_role', `unknown role ${role}`);
  const normalized = normalizeEmail(email);

  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`invite:${projectId}:${normalized}`]);
    await requireActorAuthority(tx, actor, projectId, ['admin']);

    // COALESCE keeps a name already recorded: re-adding someone, or adding them to a
    // second project under a different spelling, must not rename them.
    const u = await tx.query(
      `INSERT INTO users (email, display_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE
          SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
       RETURNING id, display_name`,
      [normalized, name?.trim() || normalized.split('@')[0]]);

    const m = await tx.query(
      `INSERT INTO memberships (project_id, user_id, role, revoked_at)
       VALUES ($1,$2,$3,NULL)
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, revoked_at = NULL
       RETURNING user_id, role`,
      [projectId, u.rows[0].id, role]);

    await tx.query(
      `INSERT INTO events (project_id, membership_user_id, actor_id, kind, payload)
       VALUES ($1,$2,$3,'membership.added',$4)`,
      [projectId, u.rows[0].id, actor.userId,
       JSON.stringify({ email: normalized, role, name: u.rows[0].display_name })]);

    return { userId: u.rows[0].id, email: normalized,
             displayName: u.rows[0].display_name, role: m.rows[0].role };
  });
}

/**
 * Redeem an invitation. One transaction: consume, upsert the user, grant the
 * membership, append the audit event — all or nothing (RGM-015). Redemption does
 * NOT create a session; the invitee signs in afterwards.
 *
 * The per-(project,email) advisory lock serialises redemption against member
 * removal, so an older invitation cannot restore access that was just revoked
 * (RGM-012 / RGM3-003).
 */
export async function redeemInvite(db, token) {
  const tokenHash = hashToken(token);
  const probe = await db.query(
    'SELECT project_id, email FROM invitations WHERE token_hash = $1', [tokenHash]);
  if (!probe.rows.length) throw new HttpError(400, 'bad_invite', 'invitation not found');
  const { project_id: projectId, email } = probe.rows[0];

  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`invite:${projectId}:${email}`]);

    const inv = await tx.query(
      `UPDATE invitations SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING id, project_id, email, role, display_name`, [tokenHash]);
    if (!inv.rows.length) {
      throw new HttpError(400, 'invite_used', 'invitation is expired, revoked or already used');
    }
    const invitation = inv.rows[0];

    const u = await tx.query(
      // The name given when they were invited; otherwise the email local part, which
      // is what everyone got before invitations could carry one.
      `INSERT INTO users (email, display_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [invitation.email,
       invitation.display_name?.trim() || invitation.email.split('@')[0]]);
    const userId = u.rows[0].id;

    await tx.query(
      `INSERT INTO memberships (project_id, user_id, role, revoked_at)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, revoked_at = NULL`,
      [invitation.project_id, userId, invitation.role]);

    await tx.query(
      `INSERT INTO events (project_id, invitation_id, actor_id, kind, payload)
       VALUES ($1, $2, $3, 'invitation.redeemed', $4)`,
      [invitation.project_id, invitation.id, userId,
        JSON.stringify({ role: invitation.role, email: invitation.email })]);

    return { userId, projectId: invitation.project_id, role: invitation.role,
             email: invitation.email };
  });
}

/**
 * Remove a member. Revokes outstanding invitations for that (project, email) and
 * cancels any queued notification, both of which would otherwise let a removed
 * person back in or keep mailing them (RGM-012, RGM3-010).
 */
export async function removeMember(db, { projectId, userId, actorId }) {
  return withTransaction(db, async (tx) => {
    const m = await tx.query(
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
      [projectId, userId]);
    if (!m.rows.length) throw new HttpError(404, 'not_a_member', 'no active membership');
    const email = m.rows[0].email;

    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`invite:${projectId}:${email}`]);

    await tx.query(
      `UPDATE memberships SET revoked_at = now()
        WHERE project_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [projectId, userId]);

    const invites = await tx.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE project_id = $1 AND email = $2 AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING id`, [projectId, email]);

    const cancelled = await tx.query(
      `UPDATE notifications_outbox SET status = 'cancelled'
        WHERE project_id = $1 AND recipient_id = $2 AND status IN ('pending','running')
        RETURNING id`, [projectId, userId]);

    await tx.query(
      `INSERT INTO events (project_id, membership_user_id, actor_id, kind, payload)
       VALUES ($1, $2, $3, 'membership.revoked', $4)`,
      [projectId, userId, actorId,
        JSON.stringify({ email, revokedInvites: invites.rows.length,
                         cancelledNotifications: cancelled.rows.length })]);

    return { email, revokedInvites: invites.rows.length,
             cancelledNotifications: cancelled.rows.length };
  });
}

/**
 * Change a member's role.
 *
 * Three things have to happen together, which is why this is not a bare UPDATE:
 *
 *   - A project-level lock, so the last-admin guard cannot be satisfied twice by
 *     two admins demoting each other concurrently (IR-015).
 *   - The same per-(project,email) lock that redemption and removal take, and
 *     revocation of outstanding invitations for that address. Without it a
 *     downgraded admin could redeem an invitation issued while they were an admin
 *     and get the role back (IR-005).
 *   - The audit event, so a role change is attributable.
 */
export async function setMemberRole(db, { projectId, userId, role, actor }) {
  if (!ROLES.includes(role)) {
    throw new HttpError(400, 'bad_role', `role must be one of ${ROLES.join(', ')}`);
  }

  return withTransaction(db, async (tx) => {
    const m = await tx.query(
      `SELECT u.email, m.role AS current_role
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL`,
      [projectId, userId]);
    if (!m.rows.length) throw new HttpError(404, 'not_a_member', 'no active membership');
    const { email, current_role: currentRole } = m.rows[0];

    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`members:${projectId}`]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`invite:${projectId}:${email}`]);

    // Under the lock, so a demotion that lands while this body was in flight is
    // seen and refused rather than applied with the rights the caller had when the
    // request began (RGM4-001).
    await requireActorAuthority(tx, actor, projectId, ['admin']);

    if (role !== 'admin' && currentRole === 'admin') {
      const admins = await tx.query(
        `SELECT count(*)::int AS c FROM active_memberships
          WHERE project_id = $1 AND role = 'admin'`, [projectId]);
      if (admins.rows[0].c <= 1) {
        throw new HttpError(400, 'last_admin', 'a project must keep at least one admin');
      }
    }

    // Any live invitation for this address is now wrong, whatever the new role:
    // it encodes the role the address was invited with, not the one they hold.
    const revoked = await tx.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE project_id = $1 AND email = $2 AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING id`, [projectId, email]);

    const updated = await tx.query(
      `UPDATE memberships SET role = $1
        WHERE project_id = $2 AND user_id = $3 AND revoked_at IS NULL
        RETURNING user_id, role`, [role, projectId, userId]);

    await tx.query(
      `INSERT INTO events (project_id, membership_user_id, actor_id, kind, payload)
       VALUES ($1, $2, $3, 'membership.role_changed', $4)`,
      [projectId, userId, actor.userId,
        JSON.stringify({ from: currentRole, to: role, revokedInvites: revoked.rows.length })]);

    return { ...updated.rows[0], from: currentRole,
             revokedInvites: revoked.rows.length };
  });
}

// ─────────────────── bootstrap (§4) ───────────────────

/**
 * Create the first site admin. Idempotent; refuses to mint a second one silently.
 */
export async function bootstrap(db, email) {
  const normalized = normalizeEmail(email);
  const existing = await db.query('SELECT id FROM users WHERE is_site_admin = true');
  if (existing.rows.length) {
    return { created: false, reason: 'a site admin already exists' };
  }
  const r = await db.query(
    `INSERT INTO users (email, display_name, is_site_admin) VALUES ($1, $2, true)
     ON CONFLICT (email) DO UPDATE SET is_site_admin = true
     RETURNING id, email`, [normalized, normalized.split('@')[0]]);
  return { created: true, userId: r.rows[0].id, email: r.rows[0].email };
}

/** Create a project plus its counter and the creator's admin membership, atomically. */
export async function createProject(db, { name, client = 'RGM', env = 'staging',
                                          timezone = 'Asia/Ho_Chi_Minh', createdBy,
                                          agentEmail = null }) {
  return withTransaction(db, async (tx) => {
    const p = await tx.query(
      `INSERT INTO projects (name, client, env, timezone) VALUES ($1,$2,$3,$4)
       RETURNING id, name, client, env, timezone`,
      [name, client, env, timezone]);
    const project = p.rows[0];

    await tx.query('INSERT INTO project_counters (project_id) VALUES ($1)', [project.id]);
    await tx.query(
      `INSERT INTO memberships (project_id, user_id, role) VALUES ($1,$2,'admin')`,
      [project.id, createdBy]);

    // The coding agent works every board, and a board it cannot see is a board
    // its bugs go unworked (rgm-leave-app sat invisible until someone noticed).
    // In this transaction deliberately: no window where the project exists and
    // the agent cannot see it, and no orphan if creation fails. DO NOTHING, not
    // DO UPDATE: when the agent creates a project itself it is already the
    // admin row, and the auto-add must never demote the account it grants.
    if (agentEmail) {
      const agent = await tx.query(`SELECT id FROM users WHERE email = $1`,
        [normalizeEmail(agentEmail)]);
      if (agent.rows.length) {
        await tx.query(
          `INSERT INTO memberships (project_id, user_id, role) VALUES ($1,$2,'developer')
           ON CONFLICT (project_id, user_id) DO NOTHING`,
          [project.id, agent.rows[0].id]);
        await tx.query(
          `INSERT INTO events (project_id, membership_user_id, actor_id, kind, payload)
           VALUES ($1,$2,$3,'membership.auto_added',$4)`,
          [project.id, agent.rows[0].id, createdBy,
            JSON.stringify({ email: normalizeEmail(agentEmail), role: 'developer',
                             via: 'RGM_AGENT_EMAIL' })]);
      }
    }

    await tx.query(
      `INSERT INTO events (project_id, actor_id, kind, payload)
       VALUES ($1,$2,'project.created',$3)`,
      [project.id, createdBy, JSON.stringify({ name, client })]);
    return project;
  });
}
