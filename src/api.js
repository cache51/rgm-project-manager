/**
 * HTTP API (§14). Every route resolves the actor, then authorizes against the
 * TARGET resource's project — never against a project id taken from the body.
 */
import { createRouter, readJson, readBytes, sendJson, sendBytes, redirect,
         resolveActor, handle, parseCookies, serializeCookie } from './http.js';
import {
  HttpError, authorize, authorizeBug, authorizeMilestone, authorizeRemovedProject,
  requireLiveProject, activeMembership, ROLES,
  requestLoginLink, consumeLoginToken, resolveSession, revokeSession,
  mintApiToken, resolveApiToken, revokeApiToken,
  createInvite, redeemInvite, removeMember, setMemberRole, addMember, directSignIn,
  bootstrap, createProject,
  normalizeEmail
} from './auth.js';
import { withTransaction } from './db.js';
import { buildPrompt } from './prompt.js';
import { packetEntryName, packetEntryNames, packetArchiveName, isSafeRelativePath,
         extensionFor, buildPacketMeta, contentDisposition } from './packet.js';
import { resolveTransition, availableTransitions, isOpenBug } from './transitions.js';
import { makeZip } from './zip.js';
import {
  enqueueBugTranslations, enqueueEventTranslation, retryTranslation
} from './translate.js';
import { enqueueReadyNotifications, enqueueRetestNotifications,
         enqueueQuestionNotifications } from './notify.js';
import { enforce, hit, LIMITS } from './ratelimit.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const MAX_ATTACHMENTS_PER_BUG = 12;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic'];

/**
 * Event kinds that are operational audit rather than part of the bug's story.
 *
 * RGM3-008: auditing reads appends events, and events feed the prompt — so a
 * developer downloading a packet would change the next packet, breaking the
 * byte-identical `bug.md` guarantee. These kinds are recorded (the trail is
 * complete) but excluded from the prompt.
 */
const AUDIT_ONLY_KINDS = new Set(['attachment.downloaded', 'packet.downloaded']);

// A report is a bug or a feature request. The workflow is the same for both, so they
// share a table and one state machine; what differs is what the work is called and how
// the report is labelled. A feature request numbered BUG-7 — in the list, in the prompt
// handed to an AI agent, and in the packet filename a developer pulls — is wrong.
const REPORT_KINDS = ['bug', 'feature'];
const reportCode = (kind, number) => `${kind === 'feature' ? 'REQ' : 'BUG'}-${number}`;

// ───────────────────── token scope policy (IR-001) ─────────────────────
//
// Scopes narrow an API token; a signed-in browser is the user's full authority
// and is not scoped. Enforcing them at each call site meant three routes were
// checked and the other thirty were not — a `bug:read` token could change bug
// status, and a read-only token could create invitations. The policy lives here,
// in one table, and `applyScopePolicy` refuses to leave a route unspecified; a
// test asserts every route appears below.

/** Reachable without a token scope (unauthenticated, or capability-addressed). */
export const PUBLIC = 'public';
/** A route nobody assigned a policy to. Denied at runtime, and a test failure. */
export const UNSPECIFIED = 'unspecified';

export const SCOPE_POLICY = {
  // Any authenticated actor, whatever the token's scopes — the CLI needs this to
  // learn who it is before it can do anything scoped.
  'GET /api/me': null,

  // Reading the product.
  'GET /api/projects': 'bug:read',
  // Reading what was removed is a read; bringing it back is an admin act, enforced on
  // the restore routes themselves.
  'GET /api/projects/removed': 'bug:read',
  'GET /api/projects/:id/milestones/removed': 'bug:read',
  'GET /api/projects/:id/bugs/removed': 'bug:read',
  'GET /api/projects/:id/milestones': 'bug:read',
  'GET /api/projects/:id/bugs': 'bug:read',
  'GET /api/projects/:id/bugs/by-number/:n': 'bug:read',
  'GET /api/bugs/:id': 'bug:read',
  'GET /api/bugs/:id/prompt': 'bug:read',
  'GET /api/bugs/:id/packet': 'bug:read',
  'GET /api/attachments/:id': 'bug:read',

  // Testers' work, and the developers' response to it.
  'POST /api/projects/:id/bugs': 'bug:write',
  'POST /api/bugs/:id/status': 'bug:write',
  'POST /api/bugs/:id/comments': 'bug:write',
  // The way back for whoever is working a bug: see questionsFor() in api.js.
  'POST /api/bugs/:id/questions': 'bug:write',
  'GET /api/bugs/:id/questions': 'bug:read',
  'POST /api/bugs/:id/questions/:questionId/answer': 'bug:write',
  // The addresses a bug notifies when it is marked fixed.
  'POST /api/bugs/:id/watchers': 'bug:write',
  'DELETE /api/bugs/:id/watchers/:email': 'bug:write',
  'POST /api/bugs/:id/retest': 'bug:write',
  'POST /api/bugs/:id/translations/:lang/retry': 'bug:write',
  'POST /api/bugs/:id/attachments/presign': 'bug:write',
  'POST /api/bugs/:id/attachments/complete': 'bug:write',
  'POST /api/projects/:id/milestones': 'bug:write',
  'POST /api/milestones/:id/status': 'bug:write',
  // A milestone is a developer's to define, so editing and removing one rides on the
  // same scope that creating one needs.
  'PATCH /api/milestones/:id': 'bug:write',
  'DELETE /api/milestones/:id': 'bug:write',
  'POST /api/milestones/:id/restore': 'bug:write',
  // Correcting what you reported is part of reporting it.
  'PATCH /api/bugs/:id': 'bug:write',

  // Administration: membership, invitations, tokens, and the route inventory.
  'POST /api/projects': 'admin',
  'PATCH /api/projects/:id': 'admin',
  'DELETE /api/projects/:id': 'admin',
  'POST /api/projects/:id/restore': 'admin',
  'GET /api/projects/:id/members': 'admin',
  'POST /api/projects/:id/invites': 'admin',
  'POST /api/projects/:id/members': 'admin',
  'DELETE /api/projects/:id/members/:userId': 'admin',
  // Removing a bug removes evidence, so it is an admin act, not a reporter's.
  'DELETE /api/bugs/:id': 'admin',
  'POST /api/bugs/:id/restore': 'admin',
  'PATCH /api/projects/:id/members/:userId': 'admin',
  'GET /api/tokens': 'admin',
  'POST /api/tokens': 'admin',
  'DELETE /api/tokens/:id': 'admin',
  'GET /api/debug/routes': 'admin'
};

export const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'POST /api/auth/request-link',
  'POST /api/auth/consume',
  // No link, no password: this IS the sign-in, so it cannot require a token scope.
  'POST /api/auth/direct',
  // Logout only revokes the caller's own session, so there is nothing to escalate.
  'POST /api/auth/logout',
  // Capability-addressed: the token in the URL is the credential.
  'POST /api/invites/redeem',
  'PUT /api/uploads/:token'
]);

/** Attach a scope to every route. Anything unlisted is denied, not defaulted open. */
export function applyScopePolicy(router) {
  for (const route of router.routes()) {
    const key = `${route.method} ${route.pattern}`;
    if (PUBLIC_ROUTES.has(key)) route.scope = PUBLIC;
    else if (Object.prototype.hasOwnProperty.call(SCOPE_POLICY, key)) {
      route.scope = SCOPE_POLICY[key];
    } else route.scope = UNSPECIFIED;
  }
  return router;
}

// ───────────────────────── loaders ─────────────────────────

async function loadBug(db, bugId) {
  const r = await db.query(
    `SELECT b.*, u.display_name AS reporter_name,
            m.code AS milestone_code, m.title_en AS milestone_title, m.title_vi AS milestone_title_vi,
            p.name AS project_name, p.client AS project_client, p.env AS project_env,
            p.timezone AS project_timezone,
            ref.id AS close_ref_id,
            CASE WHEN ref.id IS NOT NULL
                 THEN (CASE WHEN ref.kind = 'feature' THEN 'REQ-' ELSE 'BUG-' END
                       || ref.bug_number) END AS close_ref_code
       FROM bugs b
       JOIN users u ON u.id = b.reporter_id
       JOIN milestones m ON m.id = b.milestone_id
       JOIN projects p ON p.id = b.project_id
       LEFT JOIN bugs ref ON ref.id = b.close_ref_bug_id
      WHERE b.id = $1 AND b.deleted_at IS NULL`, [bugId]);
  return r.rows[0] ?? null;
}

async function timelineFor(db, bugId) {
  const r = await db.query(
    `SELECT e.id, e.kind, e.payload, e.at, u.display_name AS actor
       FROM events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.bug_id = $1 ORDER BY e.id`, [bugId]);

  const notes = await db.query(
    `SELECT event_id, lang, status, text FROM event_translations
      WHERE event_id = ANY($1::bigint[])`, [r.rows.map(x => x.id)]);

  const byEvent = {};
  for (const n of notes.rows) {
    byEvent[n.event_id] ??= {};
    byEvent[n.event_id][n.lang] = { status: n.status, text: n.text };
  }

  return r.rows.map(row => ({
    id: row.id,
    at: iso(row.at),
    actor: row.actor ?? 'system',
    kind: row.kind,
    note: row.payload?.note ?? null,
    reason: row.payload?.reason ?? null,
    closeKind: row.payload?.closeKind ?? null,
    closeRefCode: row.payload?.closeRefCode ?? null,
    result: row.payload?.result ?? null,
    to: row.payload?.to ?? null,
    noteTranslations: byEvent[row.id] ?? {}
  }));
}

async function translationsFor(db, bugId) {
  const r = await db.query(
    `SELECT field, lang, status, text, error, attempts, provider, model
       FROM bug_translations WHERE bug_id = $1`, [bugId]);
  const out = {};
  for (const row of r.rows) {
    out[row.field] ??= {};
    out[row.field][row.lang] = {
      status: row.status, text: row.text, error: row.error, attempts: row.attempts
    };
  }
  return out;
}

async function attachmentsFor(db, bugId) {
  const r = await db.query(
    `SELECT id, storage_key, filename, byte_size, content_type, uploaded_at
       FROM bug_attachments WHERE bug_id = $1 ORDER BY uploaded_at, id`, [bugId]);
  return r.rows;
}

function projectRef(bug) {
  return { id: bug.project_id, name: bug.project_name, client: bug.project_client,
           env: bug.project_env, timezone: bug.project_timezone };
}

/**
 * A shape check, not a deliverability check: something@something.tld, no spaces.
 * Rejecting a malformed address here is kinder than queueing mail that can never
 * be sent.
 */
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(e ?? ''));

/** At most this many addresses on one bug — a bounded, reviewable list. */
const WATCHER_LIMIT = 10;

/**
 * The questions asked about one bug, oldest first, each with its answer.
 *
 * `open` is returned alongside because it is the question both readers ask
 * first: a person wants to know what still needs them, and the agent that asked
 * wants to know whether it may carry on.
 */
async function questionsFor(db, bugId) {
  const r = await db.query(
    `SELECT q.id, q.body, q.created_at, q.answered_at, q.answer,
            asker.display_name AS asked_by_name, asker.email AS asked_by_email,
            answerer.display_name AS answered_by_name, answerer.email AS answered_by_email
       FROM bug_questions q
       LEFT JOIN users asker ON asker.id = q.asked_by
       LEFT JOIN users answerer ON answerer.id = q.answered_by
      WHERE q.bug_id = $1
      ORDER BY q.created_at, q.id`, [bugId]);
  const questions = r.rows.map((q) => ({
    id: q.id,
    body: q.body,
    askedAt: iso(q.created_at),
    askedBy: q.asked_by_name ?? q.asked_by_email ?? null,
    open: q.answered_at === null,
    answer: q.answered_at === null ? null : {
      text: q.answer,
      at: iso(q.answered_at),
      by: q.answered_by_name ?? q.answered_by_email ?? null
    }
  }));
  return { open: questions.filter((q) => q.open).length, questions };
}

async function watchersFor(db, bugId) {
  const r = await db.query(
    `SELECT w.email, w.added_at, u.display_name AS added_by_name
       FROM bug_watchers w
       LEFT JOIN users u ON u.id = w.added_by
      WHERE w.bug_id = $1
      ORDER BY w.added_at, w.email`, [bugId]);
  return r.rows.map((w) => ({
    email: w.email, addedAt: iso(w.added_at), addedBy: w.added_by_name ?? null
  }));
}

async function bugPayload(db, bug, role = 'developer') {
  const [translations, timeline, attachments, watchers, questions] = await Promise.all([
    translationsFor(db, bug.id), timelineFor(db, bug.id), attachmentsFor(db, bug.id),
    // The addresses that hear when this bug is marked fixed.
    watchersFor(db, bug.id),
    // What whoever is working this bug had to ask, and what came back.
    questionsFor(db, bug.id)
  ]);
  return {
    id: bug.id,
    code: reportCode(bug.kind, bug.bug_number),
    kind: bug.kind,
    number: bug.bug_number,
    projectId: bug.project_id,
    milestone: { id: bug.milestone_id, code: bug.milestone_code, title: bug.milestone_title },
    severity: bug.severity,
    status: bug.status,
    isOpen: isOpenBug(bug.status),
    retestAttempt: bug.retest_attempt,
    retestAssigneeId: bug.retest_assignee_id,
    // How an open bug was closed: a duplicate names the report it duplicates.
    closeKind: bug.close_kind ?? null,
    closeRef: bug.close_ref_code ? { id: bug.close_ref_id, code: bug.close_ref_code } : null,
    reporter: { id: bug.reporter_id, name: bug.reporter_name },
    titleVi: bug.title_vi,
    bodyVi: bug.body_vi,
    createdAt: iso(bug.created_at),
    updatedAt: iso(bug.updated_at),
    translations,
    timeline,
    // Index by position: a hard-coded 1 here labelled every screenshot
    // "screenshot_01.png" even though the packet itself numbered them correctly.
    attachments: attachments.map((a, i) => ({
      id: a.id, name: packetEntryName(i + 1, a.content_type),
      originalFilename: a.filename, contentType: a.content_type,
      byteSize: Number(a.byte_size), uploadedAt: iso(a.uploaded_at),
      url: `/api/attachments/${a.id}`
    })),
    // Addresses the developer attached to this bug: they are mailed when it is
    // marked fixed.
    watchers,
    // Questions asked about this bug (usually by an agent at work on it), each
    // with its answer or the fact that it is still open.
    questions,
    // Actions the CALLER can actually take — a tester must not be offered
    // developer-only transitions the server would reject.
    availableActions: availableTransitions('bug', bug.status, role)
  };
}

// ───────────────────────── routes ─────────────────────────

export function buildRoutes() {
  const r = createRouter();

  // ── health ──
  r.get('/api/health', handle(async (req, res, ctx) => {
    await ctx.db.query('SELECT 1 AS runtime_ready');
    sendJson(res, 200, { ok: true });
  }));

  // ── auth (§4) ──
  r.post('/api/auth/request-link', handle(async (req, res, ctx) => {
    const { email } = await readJson(req);
    if (!email) throw new HttpError(400, 'email_required', 'email is required');

    const ip = req.socket?.remoteAddress ?? 'unknown';
    const limits = ctx.limits ?? LIMITS;
    const gate = await enforce(ctx.db, [
      [`login:email:${normalizeEmail(email)}`, limits.loginLinkPerEmail],
      [`login:ip:${ip}`, limits.loginLinkPerIp]
    ]);
    if (!gate.allowed) {
      // Note this is the same shape for a known and an unknown address, so the
      // limiter cannot be used to probe which addresses exist.
      throw new HttpError(429, 'rate_limited',
        `too many sign-in links requested; retry in ${gate.failed.retryAfter}s`,
        { retryAfter: gate.failed.retryAfter });
    }

    // Always the same response, so this cannot be used to enumerate accounts.
    //
    // The mail is scheduled for after the response has closed, so no mailer work
    // — not even its synchronous prefix — shares this request's event-loop turn
    // (IR-019). 'close' rather than 'finish' so an aborted connection still
    // delivers; a caller who aborts cannot observe the server's later work.
    const deferred = [];
    await requestLoginLink(ctx.db, email, {
      deliver: ctx.deliver, ip,
      defer: (run) => { deferred.push(run); }
    });
    sendJson(res, 200, { ok: true });
    if (deferred.length) {
      res.once('close', () => { for (const run of deferred) run(); });
    }
  }));

  r.post('/api/auth/consume', handle(async (req, res, ctx) => {
    const { token } = await readJson(req);
    if (!token) throw new HttpError(400, 'token_required', 'token is required');

    const ip = req.socket?.remoteAddress ?? 'unknown';
    const limits = ctx.limits ?? LIMITS;
    const gate = await hit(ctx.db, `consume:ip:${ip}`, limits.consumePerIp);
    if (!gate.allowed) {
      throw new HttpError(429, 'rate_limited',
        `too many sign-in attempts; retry in ${gate.retryAfter}s`,
        { retryAfter: gate.retryAfter });
    }

    const session = await consumeLoginToken(ctx.db, token);
    if (!session) throw new HttpError(400, 'bad_token', 'link is invalid or expired');
    const maxAge = 30 * 24 * 3600;
    sendJson(res, 200, { ok: true }, {
      // The session cookie is HttpOnly; the CSRF cookie must be readable by the
      // app so it can echo it back in a header. It is not a secret on its own —
      // it is only valid together with this session's cookie.
      'set-cookie': [
        serializeCookie('session', session.sessionToken,
          { maxAge, secure: ctx.secureCookies }),
        serializeCookie('csrf', session.csrfToken,
          { maxAge, httpOnly: false, secure: ctx.secureCookies })
      ]
    });
  }));

  /**
   * Sign in with an email address — no link, no password.
   *
   * The deployment has no mailer, so the link flow needed someone to read a URL out of
   * the server console for every sign-in. This opens a session for an address an admin
   * has already added; the role comes from the membership. See `directSignIn` for what
   * this deliberately does not prove.
   */
  r.post('/api/auth/direct', handle(async (req, res, ctx) => {
    const { email } = await readJson(req);
    if (!email) throw new HttpError(400, 'email_required', 'an email address is required');

    // Rate limited like the other unauthenticated endpoint, so the address list cannot
    // be probed at speed.
    const ip = req.socket?.remoteAddress ?? 'unknown';
    const limits = ctx.limits ?? LIMITS;
    const gate = await hit(ctx.db, `direct:ip:${ip}`, limits.consumePerIp);
    if (!gate.allowed) {
      throw new HttpError(429, 'rate_limited',
        `too many sign-in attempts; retry in ${gate.retryAfter}s`,
        { retryAfter: gate.retryAfter });
    }

    const session = await directSignIn(ctx.db, email);
    if (!session) {
      throw new HttpError(404, 'no_such_user',
        'that address is not on any project yet — ask an admin to add you');
    }

    const maxAge = 30 * 24 * 3600;
    sendJson(res, 200, { ok: true }, {
      'set-cookie': [
        serializeCookie('session', session.sessionToken,
          { maxAge, secure: ctx.secureCookies }),
        serializeCookie('csrf', session.csrfToken,
          { maxAge, httpOnly: false, secure: ctx.secureCookies })
      ]
    });
  }));

  r.post('/api/auth/logout', handle(async (req, res, ctx) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.session) await revokeSession(ctx.db, cookies.session);
    sendJson(res, 200, { ok: true }, {
      'set-cookie': [
        serializeCookie('session', '', { maxAge: 0 }),
        serializeCookie('csrf', '', { maxAge: 0, httpOnly: false })
      ]
    });
  }));

  r.get('/api/me', handle(async (req, res, ctx) => {
    if (!ctx.actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
    const projects = await ctx.db.query(
      `SELECT p.id, p.name, p.client, p.env, m.role
         FROM active_memberships m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = $1 AND p.deleted_at IS NULL ORDER BY p.name`, [ctx.actor.userId]);
    sendJson(res, 200, {
      userId: ctx.actor.userId, email: ctx.actor.email,
      isSiteAdmin: !!ctx.actor.isSiteAdmin, via: ctx.actor.via,
      projects: projects.rows
    });
  }));

  // ── API tokens (§10) ──
  r.post('/api/tokens', handle(async (req, res, ctx) => {
    if (!ctx.actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
    if (ctx.actor.via === 'api_token') {
      throw new HttpError(403, 'forbidden', 'a token may not mint another token');
    }
    const { name, scopes = ['bug:read'] } = await readJson(req);
    if (!name) throw new HttpError(400, 'name_required', 'name is required');
    const token = await mintApiToken(ctx.db, ctx.actor.userId, { name, scopes });
    // The plaintext is returned exactly once.
    sendJson(res, 201, token);
  }));

  r.get('/api/tokens', handle(async (req, res, ctx) => {
    if (!ctx.actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
    const rows = await ctx.db.query(
      `SELECT id, name, scopes, expires_at, revoked_at, last_used_at
         FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`, [ctx.actor.userId]);
    sendJson(res, 200, { tokens: rows.rows });
  }));

  r.del('/api/tokens/:id', handle(async (req, res, ctx) => {
    if (!ctx.actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
    const ok = await revokeApiToken(ctx.db, ctx.actor.userId, ctx.params.id);
    if (!ok) throw new HttpError(404, 'not_found', 'token not found');
    sendJson(res, 200, { ok: true });
  }));

  // ── projects ──
  r.post('/api/projects', handle(async (req, res, ctx) => {
    if (!ctx.actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
    if (!ctx.actor.isSiteAdmin) {
      throw new HttpError(403, 'forbidden', 'only a site admin may create projects');
    }
    const { name, client, env, timezone } = await readJson(req);
    // `client` is optional: this is a single-client shop, and every project is an RGM
    // project. The column stays (prompts and packets render it) with a default, so
    // naming one later is a data change rather than a schema change.
    if (!name) throw new HttpError(400, 'missing_fields', 'name required');
    const project = await createProject(ctx.db, {
      name, client, env, timezone, createdBy: ctx.actor.userId
    });
    sendJson(res, 201, project);
  }));

  r.get('/api/projects', handle(async (req, res, ctx) => {
    if (!ctx.actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
    const rows = await ctx.db.query(
      `SELECT p.id, p.name, p.client, p.env, p.timezone, m.role
         FROM active_memberships m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = $1 AND p.deleted_at IS NULL ORDER BY p.name`, [ctx.actor.userId]);
    sendJson(res, 200, { projects: rows.rows });
  }));

  r.get('/api/projects/:id/members', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id);
    const rows = await ctx.db.query(
      `SELECT u.id, u.email, u.display_name, m.role
         FROM active_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 ORDER BY m.role, u.email`, [ctx.params.id]);
    sendJson(res, 200, { members: rows.rows });
  }));

  /**
   * Add someone to the project: email, name, role — applied immediately.
   *
   * The no-secret counterpart of an invitation. An admin states the mapping and it
   * exists; nothing has to be delivered, so nothing has to be read out of a console.
   */
  r.post('/api/projects/:id/members', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const { email, name, role } = await readJson(req);
    if (!email || !role) throw new HttpError(400, 'missing_fields', 'email and role required');

    const member = await addMember(ctx.db, {
      projectId: ctx.params.id, email, name, role, actor: ctx.actor
    });
    sendJson(res, 201, member);
  }));

  // ───────────────── editing and removing ─────────────────
  //
  // Until now a project, a milestone or a bug could be created and moved through its
  // lifecycle, but never corrected and never taken back. Removal is a soft delete —
  // the same `deleted_at` bugs have had since 001_init — because a bug is evidence and
  // a project holds that history. Nothing here destroys a row.

  /** Edit a project: its name, environment or timezone. */
  r.patch('/api/projects/:id', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const { name, env, timezone } = await readJson(req);
    const trimmed = name === undefined ? null : String(name).trim();
    if (name !== undefined && !trimmed) {
      throw new HttpError(400, 'bad_name', 'a project name cannot be empty');
    }

    const updated = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE projects
            SET name = COALESCE($2, name), env = COALESCE($3, env),
                timezone = COALESCE($4, timezone)
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, name, client, env, timezone`,
        [ctx.params.id, trimmed, env ?? null, timezone ?? null]);
      await tx.query(
        `INSERT INTO events (project_id, actor_id, kind, payload)
         VALUES ($1,$2,'project.updated',$3)`,
        [ctx.params.id, ctx.actor.userId,
         JSON.stringify({ name: trimmed, env: env ?? null, timezone: timezone ?? null })]);
      return r.rows[0];
    });
    sendJson(res, 200, updated);
  }));

  /** Remove a project. The data stays; it stops being listed and stops accepting writes. */
  r.del('/api/projects/:id', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const removed = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE projects SET deleted_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, name`, [ctx.params.id]);
      await tx.query(
        `INSERT INTO events (project_id, actor_id, kind, payload)
         VALUES ($1,$2,'project.removed',$3)`,
        [ctx.params.id, ctx.actor.userId, JSON.stringify({ name: r.rows[0]?.name ?? null })]);
      return r.rows[0];
    });
    sendJson(res, 200, { ok: true, ...removed });
  }));

  /** Bring a removed project back. */
  r.post('/api/projects/:id/restore', handle(async (req, res, ctx) => {
    await authorizeRemovedProject(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const restored = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE projects SET deleted_at = NULL WHERE id = $1 RETURNING id, name`,
        [ctx.params.id]);
      if (!r.rows.length) throw new HttpError(404, 'not_found', 'project not found');
      await tx.query(
        `INSERT INTO events (project_id, actor_id, kind, payload)
         VALUES ($1,$2,'project.restored',$3)`,
        [ctx.params.id, ctx.actor.userId, JSON.stringify({ name: r.rows[0].name })]);
      return r.rows[0];
    });
    sendJson(res, 200, { ok: true, ...restored });
  }));

  /**
   * Edit a milestone: its titles or its due date.
   *
   * Only the fields actually sent are touched, so clearing a Vietnamese title is
   * possible without accidentally clearing the one in English.
   */
  r.patch('/api/milestones/:id', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeMilestone(ctx.db, ctx.actor, ctx.params.id,
      ['admin', 'developer']);
    const { titleEn, titleVi, titleZh, dueAt } = await readJson(req);
    if (titleEn !== undefined && !String(titleEn).trim()) {
      throw new HttpError(400, 'bad_title', 'a milestone name cannot be empty');
    }

    const values = [ctx.params.id];
    const sets = [];
    const set = (col, value) => {
      if (value === undefined) return;
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    };
    set('title_en', titleEn === undefined ? undefined : String(titleEn).trim());
    set('title_vi', titleVi);
    set('title_zh', titleZh);
    set('due_at', dueAt);

    if (!sets.length) throw new HttpError(400, 'nothing_to_change', 'no fields were given');

    const updated = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE milestones SET ${sets.join(', ')}
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, code, title_en, title_vi, title_zh, status, due_at, completed_at`,
        values);
      await tx.query(
        `INSERT INTO events (project_id, milestone_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'milestone.updated',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
         JSON.stringify({ fields: sets.map(s => s.split(' =')[0]) })]);
      return r.rows[0];
    });
    sendJson(res, 200, updated);
  }));

  /** Remove a milestone. Its bugs stay, and stay attached to it. */
  r.del('/api/milestones/:id', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeMilestone(ctx.db, ctx.actor, ctx.params.id,
      ['admin', 'developer']);
    const removed = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE milestones SET deleted_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, code, title_en`, [ctx.params.id]);
      await tx.query(
        `INSERT INTO events (project_id, milestone_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'milestone.removed',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
         JSON.stringify({ code: r.rows[0]?.code ?? null })]);
      return r.rows[0];
    });
    sendJson(res, 200, { ok: true, ...removed });
  }));

  /** Bring a removed milestone back. */
  r.post('/api/milestones/:id/restore', handle(async (req, res, ctx) => {
    const row = await ctx.db.query('SELECT project_id FROM milestones WHERE id = $1',
      [ctx.params.id]);
    if (!row.rows.length) throw new HttpError(404, 'not_found', 'milestone not found');
    const projectId = row.rows[0].project_id;
    // authorizeMilestone would refuse a removed milestone, and restoring is exactly the
    // act of handling one — so authorize against the project, which must itself be live:
    // a milestone cannot come back into a project that is still removed.
    await requireLiveProject(ctx.db, projectId);
    await authorize(ctx.db, ctx.actor, projectId, ['admin', 'developer']);

    const restored = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE milestones SET deleted_at = NULL WHERE id = $1
          RETURNING id, code, title_en, status`, [ctx.params.id]);
      await tx.query(
        `INSERT INTO events (project_id, milestone_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'milestone.restored',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
         JSON.stringify({ code: r.rows[0].code })]);
      return r.rows[0];
    });
    sendJson(res, 200, { ok: true, ...restored });
  }));

  r.post('/api/projects/:id/invites', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const { email, role, name, ttlHours } = await readJson(req);
    if (!email || !role) throw new HttpError(400, 'missing_fields', 'email and role required');
    await createInvite(ctx.db, {
      projectId: ctx.params.id, email, role, name, ttlHours,
      actor: ctx.actor, deliver: ctx.deliver
    });
    sendJson(res, 201, { ok: true });
  }));

  r.post('/api/invites/redeem', handle(async (req, res, ctx) => {
    const { token } = await readJson(req);
    if (!token) throw new HttpError(400, 'token_required', 'token is required');
    const result = await redeemInvite(ctx.db, token);
    // Redemption grants membership only — no session is issued here.
    sendJson(res, 200, { ok: true, projectId: result.projectId, role: result.role });
  }));

  r.del('/api/projects/:id/members/:userId', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const result = await removeMember(ctx.db, {
      projectId: ctx.params.id, userId: ctx.params.userId, actorId: ctx.actor.userId
    });
    sendJson(res, 200, result);
  }));

  // RGM3-009: the plan promised role changes; there was no endpoint for one.
  r.patch('/api/projects/:id/members/:userId', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const { role } = await readJson(req);

    // Validation, the last-admin guard, the invitation revocation and the audit
    // event all happen inside one transaction in `setMemberRole` — doing the guard
    // out here let two admins demote each other past it (IR-005, IR-015).
    const updated = await setMemberRole(ctx.db, {
      projectId: ctx.params.id,
      userId: ctx.params.userId,
      role,
      actor: ctx.actor
    });

    sendJson(res, 200, updated);
  }));

  // ── milestones ──
  r.post('/api/projects/:id/milestones', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin', 'developer']);
    const { code, titleEn, titleVi, titleZh, dueAt } = await readJson(req);
    if (!code || !titleEn) throw new HttpError(400, 'missing_fields', 'code and titleEn required');
    const ins = await ctx.db.query(
      `INSERT INTO milestones (project_id, code, title_en, title_vi, title_zh, due_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, code, title_en, status`,
      [ctx.params.id, code, titleEn, titleVi ?? null, titleZh ?? null, dueAt ?? null]);
    sendJson(res, 201, ins.rows[0]);
  }));

  /**
   * The projects this actor can bring back.
   *
   * Removal hides a project from every list — which would make it unrecoverable from
   * the app, leaving hand-written SQL as the only way back. This is what the sidebar's
   * "removed" section reads.
   */
  r.get('/api/projects/removed', handle(async (req, res, ctx) => {
    if (!ctx.actor) throw new HttpError(401, 'unauthenticated', 'sign in required');
    // Only admins can restore, so only admins are shown what can be restored.
    const rows = await ctx.db.query(
      `SELECT p.id, p.name, p.env, p.deleted_at
         FROM active_memberships m JOIN projects p ON p.id = m.project_id
        WHERE p.deleted_at IS NOT NULL
          AND (m.user_id = $1 AND (m.role = 'admin' OR $2::bool))
        ORDER BY p.deleted_at DESC`, [ctx.actor.userId, !!ctx.actor.isSiteAdmin]);
    sendJson(res, 200, { projects: rows.rows });
  }));

  r.get('/api/projects/:id/milestones', handle(async (req, res, ctx) => {
    const role = await authorize(ctx.db, ctx.actor, ctx.params.id);
    const rows = await ctx.db.query(
      `SELECT id, code, title_en, title_vi, title_zh, status, due_at, completed_at,
              ready_count, updated_at
         FROM milestones WHERE project_id = $1 AND deleted_at IS NULL ORDER BY code`,
      [ctx.params.id]);
    sendJson(res, 200, {
      milestones: rows.rows.map((m) => ({
        ...m,
        // Which moves are legal from here, decided by the same state machine the
        // route enforces. The browser must not keep its own copy of this: a client-side
        // guess drifts, and then offers a button the server refuses.
        availableActions: availableTransitions('milestone', m.status, role,
          { isSiteAdmin: !!ctx.actor?.isSiteAdmin })
      }))
    });
  }));

  r.post('/api/milestones/:id/status', handle(async (req, res, ctx) => {
    const { projectId, role } = await authorizeMilestone(ctx.db, ctx.actor, ctx.params.id,
      ['admin', 'developer']);
    const { action, reason } = await readJson(req);

    const result = await withTransaction(ctx.db, async (tx) => {
      const cur = await tx.query(
        `SELECT id, code, status, ready_count FROM milestones WHERE id = $1 FOR UPDATE`,
        [ctx.params.id]);
      const m = cur.rows[0];
      const move = resolveTransition('milestone', action, m.status, role,
        { reason, isSiteAdmin: ctx.actor.isSiteAdmin });

      const generation = move.to === 'ready' ? m.ready_count + 1 : m.ready_count;
      const upd = await tx.query(
        `UPDATE milestones
            SET status = $1, ready_count = $2, updated_at = now(),
                completed_at = CASE WHEN $1 = 'done' THEN now() ELSE completed_at END
          WHERE id = $3 RETURNING id, status, ready_count`,
        [move.to, generation, ctx.params.id]);

      await tx.query(
        `INSERT INTO events (project_id, milestone_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,$4,$5)`,
        [projectId, ctx.params.id, ctx.actor.userId, `milestone.${move.to}`,
          JSON.stringify({ action, from: move.from, reason: reason ?? null })]);

      let notified = { queued: 0, recipients: 0 };
      if (move.notifies) {
        notified = await enqueueReadyNotifications(tx, {
          projectId, milestoneId: ctx.params.id, generation, milestoneCode: m.code
        });
      }
      return { milestone: upd.rows[0], notified };
    });

    sendJson(res, 200, result);
  }));

  // ── bugs ──
  r.post('/api/projects/:id/bugs', handle(async (req, res, ctx) => {
    const role = await authorize(ctx.db, ctx.actor, ctx.params.id);

    const { milestoneId, severity, titleVi, bodyVi, kind = 'bug' } = await readJson(req);
    // The kind defaults to a bug: every report before this existed was one, and a
    // caller that knows nothing about kinds keeps working.
    if (!milestoneId || !severity || !titleVi || !bodyVi) {
      throw new HttpError(400, 'missing_fields',
        'milestoneId, severity, titleVi and bodyVi are required');
    }
    if (!REPORT_KINDS.includes(kind)) {
      throw new HttpError(400, 'bad_kind', `kind must be one of ${REPORT_KINDS.join(', ')}`);
    }
    if (!['high', 'medium', 'low'].includes(severity)) {
      throw new HttpError(400, 'bad_severity', 'severity must be high, medium or low');
    }
    // The composite FK would reject this anyway; checking first turns an opaque
    // 500 into a clear 400 and avoids a pointless transaction.
    const ms = await ctx.db.query(
      'SELECT id FROM milestones WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
      [milestoneId, ctx.params.id]);
    if (!ms.rows.length) {
      throw new HttpError(400, 'bad_milestone', 'milestone does not belong to this project');
    }

    // Bug + counter + translation rows in ONE transaction. No uploads happen here,
    // so the counter lock is never held across a multi-MB transfer (RGM2-006).
    const bug = await withTransaction(ctx.db, async (tx) => {
      const c = await tx.query(
        `UPDATE project_counters SET next_bug_number = next_bug_number + 1
          WHERE project_id = $1 RETURNING next_bug_number - 1 AS number`, [ctx.params.id]);
      if (!c.rows.length) throw new HttpError(500, 'no_counter', 'project has no counter');
      const number = c.rows[0].number;

      // The composite FK makes a cross-project milestone impossible to store.
      const ins = await tx.query(
        `INSERT INTO bugs (project_id, milestone_id, bug_number, reporter_id, severity,
                           title_vi, body_vi, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, bug_number`,
        [ctx.params.id, milestoneId, number, ctx.actor.userId, severity, titleVi, bodyVi,
         kind]);

      const bugId = ins.rows[0].id;
      await enqueueBugTranslations(tx, { bugId });

      const ev = await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.filed',$4) RETURNING id`,
        [ctx.params.id, bugId, ctx.actor.userId,
          JSON.stringify({ severity, milestoneId, role })]);

      // The note-less filed event has nothing to translate.
      if (ev.rows.length === 0) throw new Error('event insert failed');
      return { id: bugId, number };
    });

    sendJson(res, 201, { id: bug.id, code: reportCode(kind, bug.number), kind });
  }));

  r.get('/api/projects/:id/bugs', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id);
    const rows = await ctx.db.query(
      `SELECT b.id, b.bug_number, b.kind, b.severity, b.status, b.title_vi, b.milestone_id,
              b.updated_at, m.code AS milestone_code,
              -- Who reported it, so a list row answers "who found this?" without
              -- opening every bug.
              u.display_name AS reporter,
              -- ::int matters: count() is int8, which node-postgres returns as a
              -- *string* (a JS number cannot hold every int8). Without the cast the
              -- row would carry "3" on PostgreSQL and 3 on PGlite.
              (SELECT count(*) FROM bug_attachments a WHERE a.bug_id = b.id)::int AS attachments,
              -- How many questions are still waiting for an answer, so the list
              -- can say "the agent is blocked on this" without opening it.
              (SELECT count(*) FROM bug_questions q
                WHERE q.bug_id = b.id AND q.answered_at IS NULL)::int AS open_questions
         FROM bugs b
         JOIN milestones m ON m.id = b.milestone_id
         JOIN users u ON u.id = b.reporter_id
        WHERE b.project_id = $1 AND b.deleted_at IS NULL
        ORDER BY b.bug_number DESC`, [ctx.params.id]);
    sendJson(res, 200, {
      bugs: rows.rows.map(b => ({ ...b, code: reportCode(b.kind, b.bug_number),
                                  // camelCase for the client; the SQL alias is snake_case.
                                  openQuestions: b.open_questions ?? 0,
                                  isOpen: isOpenBug(b.status) })),
      openCount: rows.rows.filter(b => isOpenBug(b.status)).length
    });
  }));

  /** Removed milestones, so removal is not a one-way door in the UI. */
  r.get('/api/projects/:id/milestones/removed', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin', 'developer']);
    const rows = await ctx.db.query(
      `SELECT id, code, title_en, title_vi, title_zh, status, deleted_at
         FROM milestones WHERE project_id = $1 AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC`, [ctx.params.id]);
    sendJson(res, 200, { milestones: rows.rows });
  }));

  /** Removed bugs, for the same reason. */
  r.get('/api/projects/:id/bugs/removed', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id, ['admin', 'developer']);
    const rows = await ctx.db.query(
      `SELECT b.id, b.bug_number, b.kind, b.title_vi, b.severity, b.status, b.deleted_at,
              u.display_name AS reporter
         FROM bugs b JOIN users u ON u.id = b.reporter_id
        WHERE b.project_id = $1 AND b.deleted_at IS NOT NULL
        ORDER BY b.deleted_at DESC`, [ctx.params.id]);
    sendJson(res, 200, {
      bugs: rows.rows.map((b) => ({ ...b, code: reportCode(b.kind, b.bug_number) }))
    });
  }));

  r.get('/api/projects/:id/bugs/by-number/:n', handle(async (req, res, ctx) => {
    await authorize(ctx.db, ctx.actor, ctx.params.id);
    const n = Number(ctx.params.n);
    if (!Number.isInteger(n)) throw new HttpError(400, 'bad_number', 'not a number');
    const found = await ctx.db.query(
      `SELECT id, kind FROM bugs
        WHERE project_id = $1 AND bug_number = $2 AND deleted_at IS NULL`,
      [ctx.params.id, n]);
    if (!found.rows.length) throw new HttpError(404, 'not_found', 'no such bug in this project');
    sendJson(res, 200, { id: found.rows[0].id, code: reportCode(found.rows[0].kind, n) });
  }));

  r.get('/api/bugs/:id', handle(async (req, res, ctx) => {
    const { role } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const bug = await loadBug(ctx.db, ctx.params.id);
    if (!bug) throw new HttpError(404, 'not_found', 'bug not found');
    sendJson(res, 200, await bugPayload(ctx.db, bug, role));
  }));

  r.get('/api/bugs/:id/prompt', handle(async (req, res, ctx) => {
    await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const bug = await loadBug(ctx.db, ctx.params.id);
    if (!bug) throw new HttpError(404, 'not_found', 'bug not found');
    const text = await buildPromptFor(ctx.db, bug);
    if (ctx.url.searchParams.get('format') === 'json') {
      sendJson(res, 200, { prompt: text });
    } else {
      sendBytes(res, 200, text, 'text/markdown; charset=utf-8');
    }
  }));

  r.post('/api/bugs/:id/status', handle(async (req, res, ctx) => {
    const { projectId, role } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id,
      ['admin', 'developer']);
    const { action, reason, assigneeId, closeKind, closeRefCode } = await readJson(req);

    if (closeKind !== undefined && !['duplicate', 'rejected'].includes(closeKind)) {
      throw new HttpError(400, 'bad_close_kind', 'closeKind must be duplicate or rejected');
    }
    if (closeKind === 'rejected' && closeRefCode) {
      throw new HttpError(400, 'bad_close_ref', 'a rejection names no other bug');
    }
    if (closeRefCode !== undefined && closeKind !== 'duplicate') {
      throw new HttpError(400, 'bad_close_ref', 'only a duplicate close names another bug');
    }

    // An assignee is optional (unassigned = any tester may retest), but if named
    // they must actually be an active member of this project.
    if (assigneeId) {
      const m = await ctx.db.query(
        `SELECT role FROM active_memberships WHERE project_id = $1 AND user_id = $2`,
        [projectId, assigneeId]);
      if (!m.rows.length) {
        throw new HttpError(400, 'bad_assignee', 'assignee is not an active member of this project');
      }
    }

    const out = await withTransaction(ctx.db, async (tx) => {
      const cur = await tx.query(
        `SELECT id, status, retest_attempt, kind, bug_number, title_vi
           FROM bugs WHERE id = $1 FOR UPDATE`,
        [ctx.params.id]);
      const b = cur.rows[0];
      const move = resolveTransition('bug', action, b.status, role,
        { reason, isSiteAdmin: ctx.actor.isSiteAdmin });

      // A duplicate close names the bug it duplicates, by its display code
      // (BUG-7 / REQ-3). Resolved here, under the row lock, so the reference is
      // a real live bug of this project and never the bug being closed.
      let closeRefId = null;
      if (closeKind === 'duplicate' && closeRefCode) {
        const m = String(closeRefCode).trim().match(/^(?:BUG|REQ)-(\d+)$/i);
        if (!m) {
          throw new HttpError(400, 'bad_close_ref', `not a bug code: ${closeRefCode}`);
        }
        const ref = await tx.query(
          `SELECT id FROM bugs WHERE project_id = $1 AND bug_number = $2 AND id <> $3
             AND deleted_at IS NULL`,
          [projectId, Number(m[1]), ctx.params.id]);
        if (!ref.rows.length) {
          throw new HttpError(404, 'no_such_bug', `no open bug ${closeRefCode} in this project`);
        }
        closeRefId = ref.rows[0].id;
      }

      const upd = await tx.query(
        `UPDATE bugs
            SET status = $1,
                retest_attempt = CASE WHEN $2 THEN retest_attempt + 1 ELSE retest_attempt END,
                -- the assignee is recorded on entry to retest, and cleared on exit
                retest_assignee_id = CASE
                  WHEN $1 <> 'retest' THEN NULL
                  WHEN $3 THEN $4::uuid
                  ELSE retest_assignee_id END,
                -- the close decision is recorded on close and forgotten on reopen.
                -- The casts matter: on a transition that carries no decision both
                -- parameters are NULL, and a NULL-only parameter in a CASE has no
                -- inferable type.
                close_kind = CASE WHEN $1 = 'closed' THEN $6::text ELSE NULL END,
                close_ref_bug_id = CASE WHEN $1 = 'closed' THEN $7::uuid ELSE NULL END,
                updated_at = now()
          WHERE id = $5
          RETURNING id, status, retest_attempt, retest_assignee_id`,
        [move.to, move.bumpsAttempt, move.recordsAssignee, assigneeId ?? null, ctx.params.id,
         closeKind ?? null, closeRefId]);

      const ev = await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [projectId, ctx.params.id, ctx.actor.userId, `bug.${move.to}`,
          JSON.stringify({ action, from: move.from, to: move.to, reason: reason ?? null,
                           closeKind: closeKind ?? null, closeRefCode: closeRefCode ?? null })]);

      if (reason) {
        await enqueueEventTranslation(tx, { eventId: ev.rows[0].id, note: reason });
      }

      // "Fixed — waiting for verification" is the moment the people attached to
      // this bug need to hear about it. Queued inside this transaction: the bug
      // cannot become verifiable without the notice that says so existing too.
      let notified = { queued: 0, recipients: 0 };
      if (move.to === 'retest') {
        const p = await tx.query(`SELECT name FROM projects WHERE id = $1`, [projectId]);
        notified = await enqueueRetestNotifications(tx, {
          projectId, bugId: ctx.params.id,
          code: reportCode(b.kind, b.bug_number),
          titleVi: b.title_vi,
          projectName: p.rows[0]?.name ?? null,
          attempt: upd.rows[0].retest_attempt
        });
      }
      return { ...upd.rows[0], notified };
    });

    sendJson(res, 200, out);
  }));

  r.post('/api/bugs/:id/retest', handle(async (req, res, ctx) => {
    const { projectId, role } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const { result, note, expectedAttempt } = await readJson(req);
    if (!['pass', 'fail'].includes(result)) {
      throw new HttpError(400, 'bad_result', 'result must be pass or fail');
    }

    const out = await withTransaction(ctx.db, async (tx) => {
      const cur = await tx.query(
        `SELECT id, status, retest_attempt, retest_assignee_id, reporter_id
           FROM bugs WHERE id = $1 FOR UPDATE`, [ctx.params.id]);
      const b = cur.rows[0];

      // A tester may record a result only if unassigned or assigned to them.
      // Admins may always record one; developers may not record a result at
      // all — verification belongs to the tester side of the loop, so the
      // developer who marked a bug fixed cannot also sign it off.
      if (role === 'developer') {
        throw new HttpError(403, 'forbidden',
          'a developer cannot verify their own fix — a tester or an admin records the result');
      }
      if (role !== 'admin' && b.retest_assignee_id && b.retest_assignee_id !== ctx.actor.userId) {
        throw new HttpError(403, 'forbidden', 'this retest is assigned to another tester');
      }

      const move = resolveTransition('bug', result === 'pass' ? 'retest_pass' : 'retest_fail',
        b.status, role, { expectedAttempt, actualAttempt: b.retest_attempt,
                          isSiteAdmin: ctx.actor.isSiteAdmin });

      const upd = await tx.query(
        `UPDATE bugs SET status = $1, updated_at = now() WHERE id = $2
         RETURNING id, status, retest_attempt`, [move.to, ctx.params.id]);

      const ev = await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [projectId, ctx.params.id, ctx.actor.userId, `bug.retest_${result}`,
          JSON.stringify({ result, note: note ?? null, attempt: b.retest_attempt,
                           from: move.from, to: move.to })]);

      if (note) await enqueueEventTranslation(tx, { eventId: ev.rows[0].id, note });
      return upd.rows[0];
    });

    sendJson(res, 200, out);
  }));

  /**
   * Correct a bug you filed: its Vietnamese title, body or severity.
   *
   * The reporter or an admin, and only while it is open — a closed bug describes a fix
   * that shipped, so changing what it says afterwards would misrepresent that.
   *
   * The important part is what happens to the translations: they are derived from the
   * Vietnamese, so editing the Vietnamese makes them wrong. Any field whose text
   * actually changed is put back to `pending`, which is what makes the worker redo it.
   * Without this the developers would keep reading a translation of a sentence the
   * tester had already corrected.
   */
  r.patch('/api/bugs/:id', handle(async (req, res, ctx) => {
    const { projectId, role } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id, ROLES);
    const { titleVi, bodyVi, severity } = await readJson(req);
    if (severity !== undefined && !['high', 'medium', 'low'].includes(severity)) {
      throw new HttpError(400, 'bad_severity', 'severity must be high, medium or low');
    }

    const current = await ctx.db.query(
      `SELECT reporter_id, status, title_vi, body_vi, severity FROM bugs WHERE id = $1`,
      [ctx.params.id]);
    const before = current.rows[0];
    if (role !== 'admin' && before.reporter_id !== ctx.actor.userId) {
      throw new HttpError(403, 'forbidden',
        'only the person who reported it, or an admin, may edit it');
    }
    if (before.status === 'closed') {
      throw new HttpError(409, 'bug_closed', 'a closed bug cannot be edited — reopen it first');
    }

    const updates = [['title_vi', titleVi], ['body_vi', bodyVi], ['severity', severity]]
      .filter(([, value]) => value !== undefined);
    if (!updates.length) throw new HttpError(400, 'nothing_to_change', 'no fields were given');

    // The Vietnamese fields whose text actually changed, so only those get retranslated.
    const staleFields = [['title', titleVi], ['body', bodyVi]]
      .filter(([field, value]) => value !== undefined && value !== before[`${field}_vi`])
      .map(([field]) => field);

    const updated = await withTransaction(ctx.db, async (tx) => {
      const values = [ctx.params.id, ...updates.map(([, value]) => value)];
      const sets = updates.map(([col], i) => `${col} = $${i + 2}`);
      const r = await tx.query(
        `UPDATE bugs SET ${sets.join(', ')}
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, bug_number, kind, severity, title_vi, body_vi, status`,
        values);

      for (const field of staleFields) {
        await tx.query(
          `UPDATE bug_translations
              SET status = 'pending', text = NULL, error = NULL, attempts = 0,
                  lease_until = NULL, claimed_by = NULL
            WHERE bug_id = $1 AND field = $2`, [ctx.params.id, field]);
      }

      await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.edited',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
         JSON.stringify({ changed: updates.map(([col]) => col), retranslating: staleFields })]);
      return r.rows[0];
    });
    sendJson(res, 200, { ...updated, code: reportCode(updated.kind, updated.bug_number) });
  }));

  /** Remove a bug. The evidence stays; the bug stops being listed. */
  r.del('/api/bugs/:id', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id, ['admin']);
    const removed = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE bugs SET deleted_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, bug_number, kind, reporter_id`, [ctx.params.id]);
      await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.removed',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
         JSON.stringify({ code: reportCode(r.rows[0]?.kind, r.rows[0]?.bug_number),
                          reportedBy: r.rows[0]?.reporter_id })]);
      return r.rows[0];
    });
    sendJson(res, 200, { ok: true, id: removed.id,
                         code: reportCode(removed.kind, removed.bug_number) });
  }));

  /** Bring a removed bug back. */
  r.post('/api/bugs/:id/restore', handle(async (req, res, ctx) => {
    const row = await ctx.db.query('SELECT project_id FROM bugs WHERE id = $1', [ctx.params.id]);
    if (!row.rows.length) throw new HttpError(404, 'not_found', 'bug not found');
    const projectId = row.rows[0].project_id;
    await requireLiveProject(ctx.db, projectId);
    await authorize(ctx.db, ctx.actor, projectId, ['admin']);

    const restored = await withTransaction(ctx.db, async (tx) => {
      const r = await tx.query(
        `UPDATE bugs SET deleted_at = NULL WHERE id = $1
          RETURNING id, bug_number, kind, status`,
        [ctx.params.id]);
      await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.restored',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
         JSON.stringify({ code: reportCode(r.rows[0].kind, r.rows[0].bug_number) })]);
      return r.rows[0];
    });
    sendJson(res, 200, { ok: true, ...restored,
                         code: reportCode(restored.kind, restored.bug_number) });
  }));

  r.post('/api/bugs/:id/comments', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const { note } = await readJson(req);
    if (!note || !String(note).trim()) throw new HttpError(400, 'note_required', 'note required');

    const ev = await withTransaction(ctx.db, async (tx) => {
      const ins = await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.commented',$4) RETURNING id`,
        [projectId, ctx.params.id, ctx.actor.userId, JSON.stringify({ note })]);
      await enqueueEventTranslation(tx, { eventId: ins.rows[0].id, note });
      return ins.rows[0];
    });
    sendJson(res, 201, { id: ev.id });
  }));

  // ─ questions about a bug: the agent's way back ──
  /**
   * Ask a question about a bug.
   *
   * The handoff used to be one-way — a prompt went out and work came back — so
   * whoever was working the report had nowhere to go when it did not add up: a
   * screenshot missing, a product code that means nothing outside the factory, a
   * sentence only the person who wrote it understands. A question is attributed,
   * mailed to the people who can answer it (the reporter and the bug's own
   * address list), and stays open until one of them answers — so "the agent is
   * waiting on us" is a fact on the bug, not something in a chat window.
   */
  r.post('/api/bugs/:id/questions', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const { body } = await readJson(req);
    const text = String(body ?? '').trim();
    if (!text) throw new HttpError(400, 'body_required', 'a question needs some text');
    if (text.length > 4000) {
      throw new HttpError(400, 'body_too_long', 'keep a question under 4000 characters');
    }

    const out = await withTransaction(ctx.db, async (tx) => {
      const ins = await tx.query(
        `INSERT INTO bug_questions (bug_id, asked_by, body)
         VALUES ($1,$2,$3) RETURNING id, created_at`,
        [ctx.params.id, ctx.actor.userId, text]);

      // Read inside the transaction: the notice names the bug and the project.
      const meta = await tx.query(
        `SELECT b.bug_number, b.kind, b.title_vi, p.name AS project_name
           FROM bugs b JOIN projects p ON p.id = b.project_id
          WHERE b.id = $1`, [ctx.params.id]);
      const row = meta.rows[0];

      await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.question',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
          JSON.stringify({ questionId: ins.rows[0].id, note: text })]);

      const notified = await enqueueQuestionNotifications(tx, {
        projectId, bugId: ctx.params.id, questionId: ins.rows[0].id,
        code: reportCode(row.kind, row.bug_number), titleVi: row.title_vi,
        projectName: row.project_name, question: text
      });

      return { id: ins.rows[0].id, createdAt: ins.rows[0].created_at, notified };
    });

    sendJson(res, 201, { id: out.id, askedAt: iso(out.createdAt), notified: out.notified });
  }));

  r.get('/api/bugs/:id/questions', handle(async (req, res, ctx) => {
    await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    sendJson(res, 200, await questionsFor(ctx.db, ctx.params.id));
  }));

  /** Answer a question. Any member may: the tester who filed it usually knows. */
  r.post('/api/bugs/:id/questions/:questionId/answer', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const { answer } = await readJson(req);
    const text = String(answer ?? '').trim();
    if (!text) throw new HttpError(400, 'answer_required', 'an answer needs some text');
    if (text.length > 4000) {
      throw new HttpError(400, 'answer_too_long', 'keep an answer under 4000 characters');
    }

    const out = await withTransaction(ctx.db, async (tx) => {
      // Conditional on the question still being open: two people answering at
      // once must not silently overwrite each other.
      const upd = await tx.query(
        `UPDATE bug_questions
            SET answered_by = $3, answered_at = now(), answer = $4
          WHERE id = $1 AND bug_id = $2 AND answered_at IS NULL
          RETURNING id, answered_at`,
        [ctx.params.questionId, ctx.params.id, ctx.actor.userId, text]);
      if (!upd.rows.length) {
        throw new HttpError(409, 'already_answered', 'that question has already been answered');
      }

      await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.question_answered',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
          JSON.stringify({ questionId: ctx.params.questionId, note: text })]);

      return upd.rows[0];
    });

    sendJson(res, 200, { id: out.id, answeredAt: iso(out.answered_at) });
  }));

  /**
   * The addresses attached to one bug.
   *
   * A developer lists the people who should hear that the fix is ready —
   * typically the tester who reported it, who may not be a project member yet.
   * The retest transition mails exactly this list, and nothing else: the list is
   * the authorization.
   */
  r.post('/api/bugs/:id/watchers', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id,
      ['admin', 'developer']);
    const { email } = await readJson(req);
    const normalized = normalizeEmail(email);
    if (!looksLikeEmail(normalized)) {
      throw new HttpError(400, 'bad_email', `not an email address: ${email ?? ''}`);
    }

    const out = await withTransaction(ctx.db, async (tx) => {
      // The row lock comes first, then the count: the other order lets two
      // requests racing at the limit both read 9 and both insert.
      await tx.query(`SELECT id FROM bugs WHERE id = $1 FOR UPDATE`, [ctx.params.id]);
      const existing = await tx.query(
        `SELECT count(*)::int AS n FROM bug_watchers WHERE bug_id = $1`, [ctx.params.id]);
      if (existing.rows[0].n >= WATCHER_LIMIT) {
        throw new HttpError(409, 'too_many_watchers',
          `at most ${WATCHER_LIMIT} addresses on one bug`);
      }

      const ins = await tx.query(
        `INSERT INTO bug_watchers (bug_id, email, added_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (bug_id, email) DO NOTHING
         RETURNING email`, [ctx.params.id, normalized, ctx.actor.userId]);

      if (ins.rows.length) {
        await tx.query(
          `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
           VALUES ($1,$2,$3,'bug.watchers',$4)`,
          [projectId, ctx.params.id, ctx.actor.userId,
            JSON.stringify({ added: normalized })]);
      }
      return { email: normalized, added: ins.rows.length === 1 };
    });

    sendJson(res, 200, out);
  }));

  r.del('/api/bugs/:id/watchers/:email', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id,
      ['admin', 'developer']);
    const normalized = normalizeEmail(ctx.params.email);

    const out = await withTransaction(ctx.db, async (tx) => {
      const del = await tx.query(
        `DELETE FROM bug_watchers WHERE bug_id = $1 AND email = $2 RETURNING email`,
        [ctx.params.id, normalized]);
      if (!del.rows.length) throw new HttpError(404, 'no_such_watcher', 'that address is not on this bug');
      await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.watchers',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
          JSON.stringify({ removed: normalized })]);
      return { email: normalized, removed: true };
    });

    sendJson(res, 200, out);
  }));

  r.post('/api/bugs/:id/translations/:lang/retry', handle(async (req, res, ctx) => {
    await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const { field = 'body' } = await readJson(req);
    const out = await retryTranslation(ctx.db, {
      bugId: ctx.params.id, field, lang: ctx.params.lang
    });
    if (!out) throw new HttpError(404, 'not_found', 'no failed translation to retry');
    sendJson(res, 200, out);
  }));

  // ── attachments: two-phase upload (§8) ──
  r.post('/api/bugs/:id/attachments/presign', handle(async (req, res, ctx) => {
    const { contentType, byteSize } = await readJson(req);

    if (!ALLOWED_IMAGE_TYPES.includes(String(contentType))) {
      throw new HttpError(400, 'bad_type', `unsupported image type: ${contentType}`);
    }
    if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > 8_000_000) {
      throw new HttpError(400, 'bad_size', 'byteSize must be 1..8000000');
    }

    const issued = await withTransaction(ctx.db, async (tx) => {
      const { projectId } = await authorizeBug(tx, ctx.actor, ctx.params.id);
      // Serialize capability issuance with hard purge. If purge owns this row,
      // authorization sees no active project; if issuance owns it, purge sees the
      // pending capability and waits for its expiry instead of losing the key.
      const project = await tx.query(
        'SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [projectId]);
      if (!project.rows.length) {
        throw new HttpError(410, 'project_removed', 'this project was removed');
      }
      const count = await tx.query(
        `SELECT count(*)::int AS c FROM bug_attachments WHERE bug_id = $1`, [ctx.params.id]);
      if (count.rows[0].c >= MAX_ATTACHMENTS_PER_BUG) {
        throw new HttpError(400, 'too_many_attachments',
          `at most ${MAX_ATTACHMENTS_PER_BUG} screenshots per bug`);
      }

      // The SERVER chooses the key: it can never contain a tester-supplied path.
      const key = ctx.storage.keyFor(projectId, ctx.params.id);
      const signed = ctx.storage.presignUpload({ key, contentType });
      await tx.query(
        `INSERT INTO pending_uploads (storage_key, project_id, bug_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [key, projectId, ctx.params.id,
          new Date(signed.expiresAt * 1000).toISOString()]);
      return { signed };
    });

    sendJson(res, 201, {
      storageKey: issued.signed.key,
      uploadUrl: issued.signed.url,
      uploadToken: issued.signed.token ?? null,
      uploadHeaders: issued.signed.headers ?? null,
      expiresAt: new Date(issued.signed.expiresAt * 1000).toISOString()
    });
  }));

  r.put('/api/uploads/:token', handle(async (req, res, ctx) => {
    // Every browser upload uses this app-local capability route, including S3.
    if (typeof ctx.storage.verifyUpload !== 'function') {
      throw new HttpError(404, 'no_upload_proxy',
        'this storage adapter does not support app-local upload capabilities');
    }
    const bytes = await readBytes(req, { limit: 8_000_000 });
    const claims = ctx.storage.verifyUpload(ctx.params.token);
    await withTransaction(ctx.db, async (tx) => {
      const pending = await tx.query(
        `SELECT u.storage_key
           FROM pending_uploads u
           JOIN projects p ON p.id = u.project_id
          WHERE u.storage_key = $1
            AND u.expires_at > now()
            AND p.deleted_at IS NULL
          FOR UPDATE OF p`,
        [claims.key]);
      if (!pending.rows.length) {
        throw new HttpError(410, 'upload_revoked',
          'this upload capability expired or its project was removed');
      }
      // Hold the project lock through publication so purge either sees this active
      // capability afterward or removes it first; it can never miss the object.
      await ctx.storage.put(claims.key, bytes, { contentType: claims.ct });
    });
    sendJson(res, 201, { storageKey: claims.key, byteSize: bytes.length });
  }));

  r.post('/api/bugs/:id/attachments/complete', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id);

    const { storageKey, uploadToken, filename, contentType } = await readJson(req);
    if (!storageKey) throw new HttpError(400, 'missing_fields', 'storageKey is required');

    // 1. If the driver issues a local capability, it must have been issued for
    //    exactly this key.
    const claims = (uploadToken && typeof ctx.storage.verifyUpload === 'function')
      ? ctx.storage.verifyUpload(uploadToken)
      : null;
    if (claims && claims.key !== storageKey) {
      throw new HttpError(400, 'key_mismatch', 'upload token does not match the storage key');
    }

    // 2. The key must belong to THIS project and THIS bug, so a key retained from
    //    another bug cannot be attached here (RGM3-004). This holds for both
    //    drivers, which is why it is not folded into the capability check.
    const expectedPrefix = `${projectId}/${ctx.params.id}/`;
    if (!storageKey.startsWith(expectedPrefix)) {
      throw new HttpError(403, 'key_mismatch', 'storage key does not belong to this bug');
    }

    // 3. A cheap existence check first, so completing an upload that never happened
    //    answers 400 instead of failing inside the promotion. The authoritative
    //    check is on the promoted key, below.
    const staged = await ctx.storage.head(storageKey);
    if (!staged || !staged.byteSize) {
      throw new HttpError(400, 'upload_missing', 'object was never uploaded');
    }

    // 4. Durably claim the destination before touching external storage. A copy
    //    can succeed while its source delete or the process itself fails; purge
    //    must be able to discover both names in every such state.
    const claim = await withTransaction(ctx.db, async (tx) => {
      const project = await tx.query(
        'SELECT id, deleted_at FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      if (!project.rows.length || project.rows[0].deleted_at) {
        throw new HttpError(410, 'project_removed', 'this project was removed');
      }
      const pending = await tx.query(
        `SELECT storage_key, final_storage_key FROM pending_uploads
          WHERE storage_key = $1
            AND project_id = $2
            AND bug_id = $3
            AND expires_at > now()
          FOR UPDATE`,
        [storageKey, projectId, ctx.params.id]);
      if (!pending.rows.length) {
        throw new HttpError(410, 'upload_revoked',
          'this upload capability expired or was already completed');
      }
      let finalKey = pending.rows[0].final_storage_key;
      if (!finalKey) {
        finalKey = typeof ctx.storage.promote === 'function'
          ? ctx.storage.keyFor(projectId, ctx.params.id)
          : storageKey;
        await tx.query(
          `UPDATE pending_uploads SET final_storage_key = $2 WHERE storage_key = $1`,
          [storageKey, finalKey]);
      }
      return { finalKey };
    });

    // 5. Reacquire the project and pending locks around promotion and database
    //    finalization. Purge either removes the committed claim first or waits and
    //    collects the finished attachment; it cannot race through the middle.
    //
    //    IR-013: validating the staged key and promoting afterwards leaves a
    //    window, because a presigned PUT stays valid until it expires. Between the
    //    two, a client can replace the object, and the promoted bytes would differ
    //    from the metadata that was checked. Reading the FINAL key closes it:
    //    whatever is there now is exactly what later views, downloads and packets
    //    will serve.
    //
    //    Inside the transaction for three more reasons: the attachment limit was
    //    only enforced when a capability was issued, so fifteen could be taken out
    //    and all completed (IR-022); the row and its event were separate commits,
    //    so a failure between them left an attachment with no history (IR-021);
    //    and the bug row is locked, so concurrent completions cannot both pass the
    //    count check.
    const inserted = await withTransaction(ctx.db, async (tx) => {
      // Purge locks the same project row before collecting attachment keys. Taking
      // it before any storage promotion makes the object move and row insert one
      // serialized operation from purge's point of view.
      const project = await tx.query(
        'SELECT id, deleted_at FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      if (!project.rows.length || project.rows[0].deleted_at) {
        throw new HttpError(410, 'project_removed', 'this project was removed');
      }
      const pending = await tx.query(
        `SELECT storage_key, final_storage_key FROM pending_uploads
          WHERE storage_key = $1
            AND project_id = $2
            AND bug_id = $3
            AND expires_at > now()
          FOR UPDATE`,
        [storageKey, projectId, ctx.params.id]);
      if (!pending.rows.length) {
        throw new HttpError(410, 'upload_revoked',
          'this upload capability expired or was already completed');
      }
      await tx.query('SELECT id FROM bugs WHERE id = $1 FOR UPDATE', [ctx.params.id]);

      const count = await tx.query(
        `SELECT count(*)::int AS c FROM bug_attachments WHERE bug_id = $1`,
        [ctx.params.id]);
      if (count.rows[0].c >= MAX_ATTACHMENTS_PER_BUG) {
        throw new HttpError(400, 'too_many_attachments',
          `at most ${MAX_ATTACHMENTS_PER_BUG} screenshots per bug`);
      }

      // Move the object off the key the client holds a capability for, using the
      // destination committed by the claim transaction above.
      const finalKey = pending.rows[0].final_storage_key ?? claim.finalKey;
      if (typeof ctx.storage.promote === 'function' && finalKey !== storageKey) {
        try {
          await ctx.storage.promote(storageKey, finalKey);
        } catch (err) {
          // Racing completions: the other one already moved it.
          throw new HttpError(409, 'upload_already_claimed',
            'this upload was already completed, or was removed');
        }
      }

      let declared;
      let byteSize;
      try {
        const head = await ctx.storage.head(finalKey);
        if (!head || !head.byteSize) {
          throw new HttpError(400, 'upload_missing', 'object was never uploaded');
        }
        if (head.byteSize > 8_000_000) {
          throw new HttpError(400, 'too_large', 'uploaded object exceeds the size limit');
        }
        byteSize = head.byteSize;

        // Three possible sources for the type, in order of trust: the capability
        // we signed, the bucket's own metadata, then the client's claim.
        declared = String(claims?.ct ?? head.contentType ?? contentType ?? '')
          .split(';')[0].trim();
        if (!ALLOWED_IMAGE_TYPES.includes(declared)) {
          throw new HttpError(400, 'bad_type',
            `unsupported image type: ${declared || '(none)'}`);
        }
        // Proves it maps to a packet entry extension before we store it.
        extensionFor(declared);
      } catch (err) {
        // The object was already moved, so a rejection here would otherwise
        // orphan it. Deleting is best-effort: the row is what matters, and the
        // caller is being told no either way.
        await ctx.storage.delete(finalKey).catch(() => {});
        throw err;
      }

      // A tester-supplied filename is stored as data; the extension is derived
      // from the validated content type, never from the name (RGM-S1-008).
      const ins = await tx.query(
        `INSERT INTO bug_attachments
           (project_id, bug_id, storage_key, filename, byte_size, content_type)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, content_type, byte_size`,
        [projectId, ctx.params.id, finalKey,
          String(filename ?? 'screenshot').slice(0, 200), byteSize, declared]);

      await tx.query(
        `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
         VALUES ($1,$2,$3,'bug.attachment_added',$4)`,
        [projectId, ctx.params.id, ctx.actor.userId,
          JSON.stringify({ attachmentId: ins.rows[0].id, filename: ins.rows[0].filename })]);

      await tx.query('DELETE FROM pending_uploads WHERE storage_key = $1', [storageKey]);

      return ins.rows[0];
    });

    sendJson(res, 201, inserted);
  }));

  r.get('/api/attachments/:id', handle(async (req, res, ctx) => {
    const a = await ctx.db.query(
      `SELECT id, project_id, bug_id, storage_key, filename, content_type, byte_size
         FROM bug_attachments WHERE id = $1`, [ctx.params.id]);
    if (!a.rows.length) throw new HttpError(404, 'not_found', 'attachment not found');
    const att = a.rows[0];
    // Authorization is against the attachment's own project, not a caller-supplied one.
    await authorize(ctx.db, ctx.actor, att.project_id);

    await ctx.db.query(
      `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
       VALUES ($1,$2,$3,'attachment.downloaded',$4)`,
      [att.project_id, att.bug_id, ctx.actor.userId,
        JSON.stringify({ attachmentId: att.id, filename: att.filename })]);

    const bytes = await ctx.storage.get(att.storage_key);
    const entryName = packetEntryNames(1, [att.content_type])[0];
    sendBytes(res, 200, bytes, att.content_type, {
      'content-disposition': contentDisposition(entryName, entryName)
    });
  }));

  // ── packet: the agent handoff (§10) ──
  r.get('/api/bugs/:id/packet', handle(async (req, res, ctx) => {
    const { projectId } = await authorizeBug(ctx.db, ctx.actor, ctx.params.id);
    const bug = await loadBug(ctx.db, ctx.params.id);
    if (!bug) throw new HttpError(404, 'not_found', 'bug not found');

    const attachments = await attachmentsFor(ctx.db, bug.id);
    // Pass the same list in: `bug.md`, `meta.json` and the archive entries have to
    // describe one set of attachments, or a concurrent upload can leave the prompt
    // naming a screenshot the archive does not contain (IR-038).
    const prompt = await buildPromptFor(ctx.db, bug, { attachments });
    const entries = packetEntryNames(attachments.length, attachments.map(a => a.content_type));

    for (const name of entries) {
      if (!isSafeRelativePath(name)) throw new HttpError(500, 'bad_entry', 'unsafe packet entry');
    }

    const files = [
      { name: 'bug.md', data: Buffer.from(prompt, 'utf8') },
      { name: 'meta.json', data: Buffer.from(JSON.stringify(buildPacketMeta({
        bug: {
          id: reportCode(bug.kind, bug.bug_number), kind: bug.kind ?? 'bug',
          severity: bug.severity, status: bug.status,
          tester: bug.reporter_name, createdAt: iso(bug.created_at),
          updatedAt: iso(bug.updated_at), milestoneCode: bug.milestone_code
        },
        project: projectRef(bug),
        attachments: attachments.map(a => ({
          id: a.id, filename: a.filename, contentType: a.content_type,
          uploadedAt: iso(a.uploaded_at)
        }))
      }), null, 2), 'utf8') }
    ];

    for (let i = 0; i < attachments.length; i++) {
      files.push({ name: entries[i], data: await ctx.storage.get(attachments[i].storage_key) });
    }

    const zip = makeZip(files);
    const archive = packetArchiveName(reportCode(bug.kind, bug.bug_number), bug.title_vi);

    // Pulling the handoff is a meaningful audit action, so it is recorded — and
    // because it is audit-only it is excluded from the prompt timeline, keeping
    // bug.md byte-identical between two pulls (RGM3-008).
    await ctx.db.query(
      `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
       VALUES ($1,$2,$3,'packet.downloaded',$4)`,
      [projectId, bug.id, ctx.actor.userId,
        JSON.stringify({ entries: entries.length + 2, archive })]);

    sendBytes(res, 200, Buffer.from(zip), 'application/zip', {
      // Non-ASCII names need the RFC 6266 form, with an ASCII fallback — and the
      // fallback has to carry the same code, or a client that reads the plain filename
      // downloads a feature request called BUG-4.
      'content-disposition': contentDisposition(archive,
        `${reportCode(bug.kind, bug.bug_number)}.zip`),
      'x-packet-entries': entries.length + 2
    });
  }));

  r.get('/api/debug/routes', handle(async (req, res) => sendJson(res, 200, { ok: true })));

  // One place decides scopes for all 33 routes, and anything it does not list is
  // denied rather than defaulted open (IR-001).
  applyScopePolicy(r);

  return r;
}

/**
 * Timestamps in the handoff prompt are rendered in the PROJECT's timezone, not as
 * raw UTC. A tester in Vietnam and a developer reading the prompt must see the same
 * wall-clock time the UI shows; handing an agent `...T22:52Z` for an event the UI
 * calls `05:52` invites it to reason about the wrong day.
 */
function stampIn(iso, timezone) {
  if (!iso) return null;
  const when = new Date(iso);
  const text = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(when);
  return `${text} (${timezone})`;
}

/**
 * Build the agent handoff prompt.
 *
 * `attachments` may be passed in when the caller has already read them — the
 * packet route builds `bug.md`, `meta.json` and the archive from one read, so a
 * screenshot cannot appear in the prompt but be missing from the ZIP, or the
 * reverse (IR-038).
 */
export async function buildPromptFor(db, bug, { attachments: given = null } = {}) {
  const [translations, timeline, attachments] = await Promise.all([
    translationsFor(db, bug.id), timelineFor(db, bug.id),
    given ? Promise.resolve(given) : attachmentsFor(db, bug.id)
  ]);
  const entries = packetEntryNames(attachments.length, attachments.map(a => a.content_type));
  const tz = bug.project_timezone ?? 'UTC';

  const pick = (field, lang) => {
    const t = translations[field]?.[lang];
    return t?.status === 'done' ? t.text : null;
  };

  // Build the per-field, per-language view the prompt reports on.
  const snapshot = {};
  for (const field of ['title', 'body']) {
    snapshot[field] = { text: {}, status: {}, error: {} };
    for (const lang of ['zh', 'en']) {
      const row = translations[field]?.[lang];
      snapshot[field].status[lang] = row?.status ?? 'missing';
      if (row?.status === 'done') snapshot[field].text[lang] = row.text;
      if (row?.error) snapshot[field].error[lang] = row.error;
    }
  }

  return buildPrompt({
    bug: {
      id: reportCode(bug.kind, bug.bug_number), kind: bug.kind ?? 'bug',
      severity: bug.severity, status: bug.status,
      titleVi: bug.title_vi, bodyVi: bug.body_vi,
      createdAt: stampIn(iso(bug.created_at), tz),
      updatedAt: stampIn(iso(bug.updated_at), tz)
    },
    project: projectRef(bug),
    milestone: { code: bug.milestone_code, title: bug.milestone_title },
    reporter: bug.reporter_name,
    translations: {
      title: snapshot.title.text,
      body: snapshot.body.text,
      availability: { title: snapshot.title.status, body: snapshot.body.status },
      errors: { title: snapshot.title.error, body: snapshot.body.error },
      state: snapshot.body.status.zh
    },
    timeline: timeline
      // Audit-only events are excluded so that downloading a packet does not
      // change the next packet (RGM3-008).
      .filter((e) => !AUDIT_ONLY_KINDS.has(e.kind))
      .map(e => ({
        at: stampIn(e.at, tz), actor: e.actor, kind: e.kind, note: e.note ?? e.reason
      })),
    attachments: attachments.map((a, i) => ({
      name: entries[i], originalFilename: a.filename
    }))
  });
}

export { loadBug, bugPayload, translationsFor, timelineFor, attachmentsFor };
