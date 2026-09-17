/**
 * Explicit lifecycle transition table (closes RGM2-010).
 *
 * The plan previously allowed `*→retest`, which silently included `closed→retest`
 * and `new→retest` — neither is a real transition. Here every transition is
 * enumerated, and an unknown (action, from) pair is rejected by construction
 * rather than by a reviewer noticing.
 *
 * Pure module: no DB, no framework. The repository layer is expected to call
 * `resolveTransition` inside the transaction that holds the subject row lock.
 */

export const MILESTONE_STATES = Object.freeze(['planned', 'in_progress', 'ready', 'done']);
export const BUG_STATES = Object.freeze(['new', 'fixing', 'retest', 'closed']);

/** Roles are project-scoped membership roles; `site_admin` also satisfies `admin`. */
const DEV = ['admin', 'developer'];
const ANY_MEMBER = ['admin', 'developer', 'tester'];
// Verification is the tester's half of the loop: the developer who marked a bug
// fixed must not also be the one who signs it off. An admin verifies when no
// tester is available.
const VERIFY = ['admin', 'tester'];

export const MILESTONE_TRANSITIONS = Object.freeze([
  { action: 'start',  from: ['planned'],     to: 'in_progress', roles: DEV },
  { action: 'ready',  from: ['in_progress'], to: 'ready',       roles: DEV, notifies: true },
  { action: 'finish', from: ['ready'],       to: 'done',        roles: DEV,
    sets: 'completed_at' },
  { action: 'reset',  from: MILESTONE_STATES, to: 'planned',    roles: ['admin'],
    requiresReason: true }
]);

export const BUG_TRANSITIONS = Object.freeze([
  { action: 'start_fixing',   from: ['new'],          to: 'fixing', roles: DEV },
  { action: 'request_retest', from: ['fixing'],       to: 'retest', roles: DEV,
    recordsAssignee: true, bumpsAttempt: true },
  { action: 'retest_fail',    from: ['retest'],       to: 'fixing', roles: VERIFY,
    requiresCurrentAttempt: true },
  { action: 'retest_pass',    from: ['retest'],       to: 'closed', roles: VERIFY,
    requiresCurrentAttempt: true },
  { action: 'close',          from: ['new', 'fixing'], to: 'closed', roles: DEV,
    requiresReason: true },
  { action: 'reopen',         from: ['closed'],       to: 'fixing', roles: DEV,
    requiresReason: true }
]);

const TABLES = {
  milestone: { transitions: MILESTONE_TRANSITIONS, states: MILESTONE_STATES },
  bug:       { transitions: BUG_TRANSITIONS,       states: BUG_STATES }
};

export class TransitionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

function findRule(kind, action) {
  const table = TABLES[kind];
  if (!table) throw new TransitionError(`unknown subject kind: ${kind}`, 'UNKNOWN_KIND');
  const rule = table.transitions.find(r => r.action === action);
  if (!rule) throw new TransitionError(`unknown action '${action}' for ${kind}`, 'UNKNOWN_ACTION');
  return rule;
}

/**
 * Validate one transition. Throws TransitionError on any invalid input so a
 * caller cannot accidentally treat a rejection as a no-op.
 *
 * @param {'bug'|'milestone'} kind
 * @param {string} action
 * @param {string} from            current persisted status
 * @param {string} role            caller's role in the project
 * @param {object} [ctx]
 * @param {string} [ctx.reason]    required by close / reopen / reset
 * @param {number} [ctx.expectedAttempt]  caller's view of retest_attempt
 * @param {number} [ctx.actualAttempt]    persisted retest_attempt
 * @param {boolean} [ctx.isSiteAdmin]
 */
export function resolveTransition(kind, action, from, role, ctx = {}) {
  const table = TABLES[kind];
  if (!table) throw new TransitionError(`unknown subject kind: ${kind}`, 'UNKNOWN_KIND');
  if (!table.states.includes(from)) {
    throw new TransitionError(`unknown ${kind} status: ${from}`, 'UNKNOWN_STATE');
  }

  const rule = findRule(kind, action);

  // The two states the old `*→retest` wildcard would have wrongly allowed.
  if (!rule.from.includes(from)) {
    throw new TransitionError(
      `cannot ${action} a ${kind} in status '${from}' (allowed from: ${rule.from.join(', ')})`,
      'ILLEGAL_TRANSITION'
    );
  }

  // A site admin acts with admin authority in any project (but still needs an
  // active membership, which the repository layer enforces separately). The first
  // revision merely appended 'admin' to the allowed list, so a site admin whose
  // project role was 'developer' could not perform admin-only transitions.
  const effectiveRole = ctx.isSiteAdmin ? 'admin' : role;
  if (!rule.roles.includes(effectiveRole)) {
    throw new TransitionError(
      `role '${role}' may not ${action} (requires: ${rule.roles.join(' or ')})`,
      'FORBIDDEN_ROLE'
    );
  }

  if (rule.requiresReason && !String(ctx.reason ?? '').trim()) {
    throw new TransitionError(`${action} requires a reason`, 'REASON_REQUIRED');
  }

  // RGM-019 / RGM2-011: a delayed result from an earlier retest cycle must not
  // close the current one.
  if (rule.requiresCurrentAttempt) {
    if (ctx.expectedAttempt === undefined || ctx.actualAttempt === undefined) {
      throw new TransitionError(`${action} requires expectedAttempt and actualAttempt`,
        'ATTEMPT_REQUIRED');
    }
    if (ctx.expectedAttempt !== ctx.actualAttempt) {
      throw new TransitionError(
        `stale retest result: expected attempt ${ctx.expectedAttempt}, current is ${ctx.actualAttempt}`,
        'STALE_ATTEMPT'
      );
    }
  }

  return {
    action: rule.action,
    from,
    to: rule.to,
    notifies: !!rule.notifies,
    sets: rule.sets ?? null,
    recordsAssignee: !!rule.recordsAssignee,
    bumpsAttempt: !!rule.bumpsAttempt
  };
}

/**
 * Every transition this actor could perform on a subject in `from` status.
 * Decided by status and role only — payload requirements (`reason`,
 * `expectedAttempt`) are validated by `resolveTransition` when the action is
 * actually submitted, not here. Otherwise a UI could never offer "Close",
 * because the dialog that collects the reason has not opened yet.
 */
export function availableTransitions(kind, from, role, ctx = {}) {
  const table = TABLES[kind];
  if (!table || !table.states.includes(from)) return [];
  const isSiteAdmin = !!ctx.isSiteAdmin;
  const effectiveRole = isSiteAdmin ? 'admin' : role;
  return table.transitions
    .filter(r => r.from.includes(from))
    .filter(r => r.roles.includes(effectiveRole))
    .map(r => ({ action: r.action, to: r.to, requiresReason: !!r.requiresReason }));
}

/** Open = anything not closed. One definition, used by every counter (RGM-007). */
export function isOpenBug(status) {
  if (!BUG_STATES.includes(status)) throw new TransitionError(`unknown bug status: ${status}`,
    'UNKNOWN_STATE');
  return status !== 'closed';
}
