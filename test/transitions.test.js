import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTransition, availableTransitions, isOpenBug,
  BUG_STATES, MILESTONE_STATES, TransitionError
} from '../src/transitions.js';

const dev = { role: 'developer' };
const tester = { role: 'tester' };
const admin = { role: 'admin' };

test('the two states the old *→retest wildcard wrongly allowed are rejected', () => {
  // These are the exact cases RGM2-010 called out.
  assert.throws(() => resolveTransition('bug', 'request_retest', 'closed', dev.role),
    (e) => e.code === 'ILLEGAL_TRANSITION');
  assert.throws(() => resolveTransition('bug', 'request_retest', 'new', dev.role),
    (e) => e.code === 'ILLEGAL_TRANSITION');
});

test('every enumerated legal transition resolves', () => {
  assert.equal(resolveTransition('bug', 'start_fixing', 'new', dev.role).to, 'fixing');
  assert.equal(resolveTransition('bug', 'request_retest', 'fixing', dev.role).to, 'retest');
  assert.equal(resolveTransition('bug', 'retest_fail', 'retest', tester.role, {
    expectedAttempt: 1, actualAttempt: 1
  }).to, 'fixing');
  assert.equal(resolveTransition('bug', 'retest_pass', 'retest', tester.role, {
    expectedAttempt: 2, actualAttempt: 2
  }).to, 'closed');
  assert.equal(resolveTransition('bug', 'close', 'new', dev.role, { reason: 'duplicate' }).to, 'closed');
  assert.equal(resolveTransition('bug', 'reopen', 'closed', dev.role, { reason: 'regressed' }).to, 'fixing');
});

test('roles are enforced', () => {
  assert.throws(() => resolveTransition('bug', 'start_fixing', 'new', tester.role),
    (e) => e.code === 'FORBIDDEN_ROLE');
  // a tester MAY record a retest result (RGM-019 / RGM2-011)
  assert.doesNotThrow(() => resolveTransition('bug', 'retest_pass', 'retest', tester.role,
    { expectedAttempt: 1, actualAttempt: 1 }));
  // ...but the developer who marked it fixed may NOT sign it off: verification
  // is the tester's half of the loop, with an admin as the fallback.
  assert.throws(() => resolveTransition('bug', 'retest_pass', 'retest', dev.role,
    { expectedAttempt: 1, actualAttempt: 1 }), (e) => e.code === 'FORBIDDEN_ROLE');
  assert.throws(() => resolveTransition('bug', 'retest_fail', 'retest', dev.role,
    { expectedAttempt: 1, actualAttempt: 1 }), (e) => e.code === 'FORBIDDEN_ROLE');
  assert.doesNotThrow(() => resolveTransition('bug', 'retest_pass', 'retest', admin.role,
    { expectedAttempt: 1, actualAttempt: 1 }));
  // only an admin may reset a milestone
  assert.throws(() => resolveTransition('milestone', 'reset', 'ready', dev.role, { reason: 'x' }),
    (e) => e.code === 'FORBIDDEN_ROLE');
  assert.doesNotThrow(() => resolveTransition('milestone', 'reset', 'ready', admin.role, { reason: 'x' }));
});

test('close and reopen require a reason; retest does not', () => {
  assert.throws(() => resolveTransition('bug', 'close', 'fixing', dev.role),
    (e) => e.code === 'REASON_REQUIRED');
  assert.throws(() => resolveTransition('bug', 'close', 'fixing', dev.role, { reason: '   ' }),
    (e) => e.code === 'REASON_REQUIRED');
  assert.doesNotThrow(() => resolveTransition('bug', 'start_fixing', 'new', dev.role));
});

test('a stale retest result cannot close a newer cycle', () => {
  // RGM-019 / RGM2-011: the delayed pass from cycle 1 must not close cycle 3.
  assert.throws(() => resolveTransition('bug', 'retest_pass', 'retest', tester.role, {
    expectedAttempt: 1, actualAttempt: 3
  }), (e) => e.code === 'STALE_ATTEMPT');
  // and the attempt must actually be supplied, not defaulted
  assert.throws(() => resolveTransition('bug', 'retest_pass', 'retest', tester.role, {}),
    (e) => e.code === 'ATTEMPT_REQUIRED');
});

test('unknown actions and states throw rather than silently no-op', () => {
  assert.throws(() => resolveTransition('bug', 'explode', 'new', dev.role),
    (e) => e.code === 'UNKNOWN_ACTION');
  assert.throws(() => resolveTransition('bug', 'start_fixing', 'banana', dev.role),
    (e) => e.code === 'UNKNOWN_STATE');
  assert.throws(() => resolveTransition('widget', 'start_fixing', 'new', dev.role),
    (e) => e.code === 'UNKNOWN_KIND');
  assert.ok(new TransitionError('x', 'Y') instanceof Error);
});

test('milestone entering ready flags a notification; reset does not', () => {
  assert.equal(resolveTransition('milestone', 'ready', 'in_progress', dev.role).notifies, true);
  assert.equal(resolveTransition('milestone', 'reset', 'ready', admin.role, { reason: 'x' }).notifies, false);
});

test('open-bug definition counts retest as open and only closed as closed', () => {
  // The mock shipped the opposite (RGM-007): it excluded retest.
  for (const s of BUG_STATES) {
    assert.equal(isOpenBug(s), s !== 'closed', `status ${s}`);
  }
  assert.equal(isOpenBug('retest'), true);
  assert.equal(BUG_STATES.filter(isOpenBug).length, 3);
});

test('availableTransitions reflects status and role', () => {
  assert.deepEqual(
    availableTransitions('bug', 'new', dev.role).map(t => t.action).sort(),
    ['close', 'start_fixing']
  );
  assert.deepEqual(
    availableTransitions('bug', 'new', tester.role).map(t => t.action),
    []
  );
  assert.deepEqual(
    availableTransitions('bug', 'retest', tester.role, { expectedAttempt: 1, actualAttempt: 1 })
      .map(t => t.action).sort(),
    ['retest_fail', 'retest_pass']
  );
  // and a developer in the same state is offered neither
  assert.deepEqual(
    availableTransitions('bug', 'retest', dev.role, { expectedAttempt: 1, actualAttempt: 1 })
      .map(t => t.action),
    []
  );
});

test('state lists are frozen so a caller cannot mutate the table', () => {
  assert.throws(() => { BUG_STATES.push('nope'); }, TypeError);
  assert.throws(() => { MILESTONE_STATES.push('nope'); }, TypeError);
});

// ── RGM-S1-004: site-admin authority ───────────────────────────────────────
test('a site admin resolves to admin authority regardless of project role', () => {
  // The first revision only appended 'admin' to the allowed list, so a site admin
  // whose project role was 'developer' could not perform admin-only transitions.
  assert.equal(
    resolveTransition('milestone', 'reset', 'ready', 'developer',
      { isSiteAdmin: true, reason: 'rework' }).to,
    'planned');

  // without the flag the same caller is still forbidden
  assert.throws(
    () => resolveTransition('milestone', 'reset', 'ready', 'developer', { reason: 'rework' }),
    (e) => e.code === 'FORBIDDEN_ROLE');

  // site authority is installation-wide, so it also lifts a tester membership
  assert.equal(
    resolveTransition('milestone', 'reset', 'ready', 'tester',
      { isSiteAdmin: true, reason: 'rework' }).to,
    'planned');
});

test('availableTransitions offers admin actions only to a site admin', () => {
  const plain = availableTransitions('milestone', 'ready', 'developer');
  assert.ok(!plain.some(t => t.action === 'reset'), 'a plain developer may not reset');

  const site = availableTransitions('milestone', 'ready', 'developer', { isSiteAdmin: true });
  assert.ok(site.some(t => t.action === 'reset'), 'a site admin must be offered reset');
  assert.ok(site.find(t => t.action === 'reset').requiresReason, 'and told a reason is needed');
});
