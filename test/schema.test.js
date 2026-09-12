import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  claimTranslation, claimOutbox, ClaimPolicy,
  parkExhaustedTranslations, parkExhaustedOutbox
} from '../src/claim.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, '..', 'db', 'migrations', '001_init.sql'), 'utf8');
const BUG_COLS = `(project_id, milestone_id, bug_number, reporter_id, severity, title_vi, body_vi)`;

/**
 * A fresh, fully-seeded database per test. Shared state plus an async setup hook
 * was racy — node:test started the first tests before the seed finished — so
 * isolation is cheaper than ordering.
 */
async function fresh() {
  const db = new PGlite();
  await db.exec(MIGRATION);
  const ids = {};

  const u = await db.query(`INSERT INTO users (email, display_name, is_site_admin) VALUES
      ('admin@rgm.local','Admin', true),
      ('dev@rgm.local','Dev', false),
      ('tester@rgm.local','Tester', false)
    RETURNING id, email`);
  for (const r of u.rows) ids[r.email.split('@')[0]] = r.id;

  const p = await db.query(`INSERT INTO projects (name, client)
    VALUES ('A','Client A'), ('B','Client B') RETURNING id, name`);
  for (const r of p.rows) ids[r.name === 'A' ? 'projA' : 'projB'] = r.id;

  await db.query(`INSERT INTO memberships (project_id, user_id, role) VALUES
      ($1,$2,'admin'), ($1,$3,'developer'), ($1,$4,'tester'), ($5,$4,'tester')`,
    [ids.projA, ids.admin, ids.dev, ids.tester, ids.projB]);
  await db.query(`INSERT INTO project_counters (project_id) VALUES ($1), ($2)`,
    [ids.projA, ids.projB]);

  const m = await db.query(`INSERT INTO milestones (project_id, code, title_en) VALUES
      ($1,'M2','A milestone'), ($2,'M2','B milestone') RETURNING id, project_id`,
    [ids.projA, ids.projB]);
  ids.mileA = m.rows.find(r => r.project_id === ids.projA).id;
  ids.mileB = m.rows.find(r => r.project_id === ids.projB).id;

  const b = await db.query(`INSERT INTO bugs ${BUG_COLS} VALUES ($1,$2,142,$3,'high','t','b')
    RETURNING id`, [ids.projA, ids.mileA, ids.dev]);
  ids.bugA = b.rows[0].id;

  return { db, ids };
}

// ═══════════════ the round-3 blockers ═══════════════

test('RGM3-001/RGM3-002: a project-level audit event IS insertable', async () => {
  const { db, ids } = await fresh();
  // The old CHECK required exactly one bug-or-milestone subject, which made the
  // §5 redemption audit event — and the whole atomic transaction — uncommittable.
  const inv = await db.query(
    `INSERT INTO invitations (project_id, email, role, token_hash, expires_at, created_by)
     VALUES ($1,'new@rgm.local','tester','tok-1', now() + interval '72 hours', $2)
     RETURNING id`, [ids.projA, ids.admin]);

  const ev = await db.query(
    `INSERT INTO events (project_id, invitation_id, actor_id, kind, payload)
     VALUES ($1,$2,$3,'invitation.redeemed','{"role":"tester"}'::jsonb) RETURNING id`,
    [ids.projA, inv.rows[0].id, ids.admin]);
  assert.ok(ev.rows[0].id, 'project-level event must be representable');

  // membership-level audit is permitted too
  const ev2 = await db.query(
    `INSERT INTO events (project_id, membership_user_id, actor_id, kind)
     VALUES ($1,$2,$3,'membership.revoked') RETURNING id`,
    [ids.projA, ids.tester, ids.admin]);
  assert.ok(ev2.rows[0].id);
});

test('an event still cannot name two subjects', async () => {
  const { db, ids } = await fresh();
  await assert.rejects(
    db.query(`INSERT INTO events (project_id, bug_id, milestone_id, kind)
              VALUES ($1,$2,$3,'bogus')`, [ids.projA, ids.bugA, ids.mileA]),
    /violates check constraint/);
});

test('RGM-016: bug_attachments FK is valid — bugs declares UNIQUE(project_id, id)', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO bug_attachments (project_id, bug_id, storage_key, filename, byte_size, content_type)
     VALUES ($1,$2,'k-1','x.png', 10, 'image/png')`, [ids.projA, ids.bugA]);
  const n = await db.query(`SELECT count(*)::int AS c FROM bug_attachments`);
  assert.equal(n.rows[0].c, 1);
});

test("RGM-001: a bug cannot reference another project's milestone", async () => {
  const { db, ids } = await fresh();
  await assert.rejects(
    db.query(`INSERT INTO bugs ${BUG_COLS} VALUES ($1,$2,777,$3,'low','t','b')`,
      [ids.projA, ids.mileB, ids.dev]),
    /violates foreign key constraint/);
});

test('an event cannot cross the project boundary either', async () => {
  const { db, ids } = await fresh();
  await assert.rejects(
    db.query(`INSERT INTO events (project_id, milestone_id, kind) VALUES ($1,$2,'x')`,
      [ids.projA, ids.mileB]),
    /violates foreign key constraint/);
});

// ═══════════════ append-only history ═══════════════

test('events are append-only in the database, not by convention', async () => {
  const { db, ids } = await fresh();
  const ev = await db.query(
    `INSERT INTO events (project_id, bug_id, actor_id, kind) VALUES ($1,$2,$3,'bug.filed')
     RETURNING id`, [ids.projA, ids.bugA, ids.dev]);
  const eventId = ev.rows[0].id;

  await assert.rejects(db.query(`UPDATE events SET kind='tampered' WHERE id=$1`, [eventId]),
    /append-only/);
  await assert.rejects(db.query(`DELETE FROM events WHERE id=$1`, [eventId]),
    /append-only/);

  const still = await db.query(`SELECT kind FROM events WHERE id=$1`, [eventId]);
  assert.equal(still.rows[0].kind, 'bug.filed', 'row must survive both attempts');
});

// ═══════════════ the corrected lease claim ═══════════════

test('RGM3-006/RGM3-001: an expired lease on a RUNNING row is reclaimable', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO bug_translations (bug_id, field, lang, status) VALUES ($1,'body','zh','pending')`,
    [ids.bugA]);

  const first = await claimTranslation(db, ids.admin);
  assert.ok(first, 'a pending job should be claimed');
  assert.equal(first.status, 'running');
  assert.equal(first.attempts, 1);

  // simulate a worker that committed 'running' and then died: the lease expires
  // while status stays 'running'. The old predicate excluded this row forever.
  await db.query(
    `UPDATE bug_translations SET lease_until = now() - interval '1 minute'
      WHERE bug_id=$1 AND field='body' AND lang='zh'`, [ids.bugA]);

  const again = await claimTranslation(db, ids.tester);
  assert.ok(again, 'an expired running lease MUST be reclaimable');
  assert.equal(again.attempts, 2);
  assert.equal(again.status, 'running');
});

test('a live lease is not stolen while the worker is still inside it', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO bug_translations (bug_id, field, lang, status) VALUES ($1,'body','zh','pending')`,
    [ids.bugA]);
  assert.ok(await claimTranslation(db, ids.admin));
  assert.equal(await claimTranslation(db, ids.tester), null,
    'a row inside its lease must not be double-claimed');
});

test('exhausted jobs stop being claimed once attempts reach the cap', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO bug_translations (bug_id, field, lang, status, attempts, lease_until)
     VALUES ($1,'body','zh','running',$2, now() - interval '1 hour')`,
    [ids.bugA, ClaimPolicy.maxAttempts]);
  assert.equal(await claimTranslation(db, ids.admin), null,
    'attempts >= maxAttempts must not be claimed');
});

test('the outbox claim has the same reclaim behaviour', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO notifications_outbox (kind, project_id, subject_id, recipient_id, dedupe_key)
     VALUES ('milestone.ready',$1,$2,$3,'k-1')`, [ids.projA, ids.mileA, ids.tester]);
  const { claimOutbox } = await import('../src/claim.js');
  const first = await claimOutbox(db, ids.admin);
  assert.equal(first.status, 'sending');
  await db.query(`UPDATE notifications_outbox SET lease_until = now() - interval '1 minute'`);
  const again = await claimOutbox(db, ids.dev);
  assert.ok(again, 'expired sending lease must be reclaimable');
  assert.equal(again.attempts, 2);
});

// ═══════════════ identity & numbering ═══════════════

test('RGM-008: bug numbers are unique per project but independent across projects', async () => {
  const { db, ids } = await fresh();
  await db.query(`INSERT INTO bugs ${BUG_COLS} VALUES ($1,$2,142,$3,'low','t','b')`,
    [ids.projB, ids.mileB, ids.dev]);
  await assert.rejects(
    db.query(`INSERT INTO bugs ${BUG_COLS} VALUES ($1,$2,142,$3,'low','t','b')`,
      [ids.projA, ids.mileA, ids.dev]),
    /duplicate key value violates unique constraint/);
});

test('RGM-011: the active_memberships view hides revoked rows', async () => {
  const { db, ids } = await fresh();
  await db.query(`UPDATE memberships SET revoked_at = now() WHERE project_id=$1 AND user_id=$2`,
    [ids.projA, ids.tester]);

  const active = await db.query(
    `SELECT role FROM active_memberships WHERE project_id=$1 AND user_id=$2`,
    [ids.projA, ids.tester]);
  assert.equal(active.rows.length, 0, 'revoked membership must not appear active');

  const raw = await db.query(
    `SELECT role FROM memberships WHERE project_id=$1 AND user_id=$2`, [ids.projA, ids.tester]);
  assert.equal(raw.rows.length, 1, 'the row is retained for history');
});

test('RGM-012: only one live invitation per (project, email)', async () => {
  const { db, ids } = await fresh();
  const insert = (role, hash) => db.query(
    `INSERT INTO invitations (project_id, email, role, token_hash, expires_at, created_by)
     VALUES ($1,'new@rgm.local',$2,$3, now() + interval '1 day', $4)`,
    [ids.projA, role, hash, ids.admin]);

  await insert('tester', 'tok-a');
  await assert.rejects(insert('developer', 'tok-b'),
    /duplicate key value violates unique constraint/);

  // revoking the first frees the slot, so a re-invitation is possible
  await db.query(`UPDATE invitations SET revoked_at = now() WHERE token_hash='tok-a'`);
  await insert('developer', 'tok-c');
  const n = await db.query(`SELECT count(*)::int AS c FROM invitations`);
  assert.equal(n.rows[0].c, 2);
});

test('RGM3-011: the outbox dedupe key allows a second readiness cycle', async () => {
  const { db, ids } = await fresh();
  const key = (gen) => `milestone.ready:${ids.mileA}:gen${gen}:${ids.tester}`;
  const put = (g) => db.query(
    `INSERT INTO notifications_outbox (kind, project_id, subject_id, recipient_id, dedupe_key)
     VALUES ('milestone.ready',$1,$2,$3,$4)`, [ids.projA, ids.mileA, ids.tester, key(g)]);

  await put(1);
  await assert.rejects(put(1), /duplicate key value violates unique constraint/);
  await put(2);   // a genuinely new cycle must NOT be suppressed
  const n = await db.query(`SELECT count(*)::int AS c FROM notifications_outbox`);
  assert.equal(n.rows[0].c, 2);
});

// ═══════════════ constraints ═══════════════

test('status and severity are constrained at the database level', async () => {
  const { db, ids } = await fresh();
  await assert.rejects(
    db.query(`INSERT INTO bugs ${BUG_COLS} VALUES ($1,$2,999,$3,'catastrophic','t','b')`,
      [ids.projA, ids.mileA, ids.dev]),
    /violates check constraint/);
  await assert.rejects(db.query(`UPDATE bugs SET status='retesting' WHERE id=$1`, [ids.bugA]),
    /violates check constraint/);
  await assert.rejects(db.query(`UPDATE milestones SET status='nearly' WHERE id=$1`, [ids.mileA]),
    /violates check constraint/);
});

test('emails are normalised to lowercase at the database level', async () => {
  const { db } = await fresh();
  await assert.rejects(
    db.query(`INSERT INTO users (email, display_name) VALUES ('MiXeD@RGM.local','x')`),
    /violates check constraint/);
});

test('a completed translation must carry text; a failed one must carry an error', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO bug_translations (bug_id, field, lang, status) VALUES ($1,'body','zh','pending')`,
    [ids.bugA]);
  await assert.rejects(
    db.query(`UPDATE bug_translations SET status='done', text=NULL WHERE bug_id=$1`, [ids.bugA]),
    /violates check constraint/);
  await assert.rejects(
    db.query(`UPDATE bug_translations SET status='failed', error=NULL WHERE bug_id=$1`, [ids.bugA]),
    /violates check constraint/);
  // a well-formed completion is accepted
  await db.query(
    `UPDATE bug_translations SET status='done', text='當我為…' WHERE bug_id=$1`, [ids.bugA]);
  const t = await db.query(`SELECT status, text FROM bug_translations WHERE bug_id=$1`, [ids.bugA]);
  assert.equal(t.rows[0].status, 'done');
});

// ═══════════════ RGM-S1-001: event translation integrity ═══════════════

test('an event translation shares the event id type and can be created in one transaction', async () => {
  const { db, ids } = await fresh();
  // The first revision typed event_id as uuid while events.id is bigserial, with no
  // FK at all — the intended single-transaction insert was impossible and an
  // orphan translation was representable.
  await db.exec('BEGIN');
  const ev = await db.query(
    `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
     VALUES ($1,$2,$3,'bug.retest_fail','{"note":"Đã test lại, vẫn lỗi"}'::jsonb)
     RETURNING id`, [ids.projA, ids.bugA, ids.dev]);
  const eventId = ev.rows[0].id;

  await db.query(
    `INSERT INTO event_translations (event_id, field, lang, status)
     VALUES ($1,'note','zh','pending')`, [eventId]);
  await db.exec('COMMIT');

  const n = await db.query(
    `SELECT count(*)::int AS c FROM event_translations WHERE event_id=$1`, [eventId]);
  assert.equal(n.rows[0].c, 1, 'the retest note is queueable in the same transaction');
});

test('an orphan event translation is rejected, not silently stored', async () => {
  const { db } = await fresh();
  await assert.rejects(
    db.query(`INSERT INTO event_translations (event_id, field, lang, status)
              VALUES (999999,'note','zh','pending')`),
    /violates foreign key constraint/);
  // a uuid-shaped value cannot masquerade as an event id either
  await assert.rejects(
    db.query(`INSERT INTO event_translations (event_id, field, lang, status)
              VALUES ($1,'note','zh','pending')`,
      ['00000000-0000-0000-0000-000000000000']),
    /invalid input syntax for type bigint|violates foreign key constraint/);
});

// ═══════════════ RGM-S1-002 / RGM-S1-003: parking ═══════════════

test('the parking sweep leaves an actively-leased translation alone', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO bug_translations (bug_id, field, lang, status, attempts, lease_until)
     VALUES ($1,'body','zh','running',$2, now() + interval '2 minutes')`,
    [ids.bugA, ClaimPolicy.maxAttempts]);

  // a job on its final permitted attempt is legitimately running
  assert.equal((await parkExhaustedTranslations(db)).length, 0,
    'a job inside its lease must not be parked');
  const live = await db.query(`SELECT status FROM bug_translations WHERE bug_id=$1`, [ids.bugA]);
  assert.equal(live.rows[0].status, 'running');

  // once the lease expires it is retired
  await db.query(`UPDATE bug_translations SET lease_until = now() - interval '1 minute'`);
  assert.equal((await parkExhaustedTranslations(db)).length, 1);
  const after = await db.query(`SELECT status, error FROM bug_translations WHERE bug_id=$1`,
    [ids.bugA]);
  assert.equal(after.rows[0].status, 'failed');
  assert.match(after.rows[0].error, /exhausted/);
});

test('an outbox row stranded at sending is retirable after its lease expires', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO notifications_outbox
       (kind, project_id, subject_id, recipient_id, dedupe_key, status, attempts, lease_until)
     VALUES ('milestone.ready',$1,$2,$3,'k-9','sending',$4, now() - interval '1 minute')`,
    [ids.projA, ids.mileA, ids.tester, ClaimPolicy.maxAttempts]);

  // exhausted: it can no longer be claimed...
  assert.equal(await claimOutbox(db, ids.admin), null);
  // ...but the sweep can retire it rather than leaving it `sending` forever
  assert.equal((await parkExhaustedOutbox(db)).length, 1);
  const row = await db.query(`SELECT status, error FROM notifications_outbox`);
  assert.equal(row.rows[0].status, 'failed');
  assert.match(row.rows[0].error, /exhausted/);
});

test('the outbox sweep also spares a job inside its lease', async () => {
  const { db, ids } = await fresh();
  await db.query(
    `INSERT INTO notifications_outbox
       (kind, project_id, subject_id, recipient_id, dedupe_key, status, attempts, lease_until)
     VALUES ('milestone.ready',$1,$2,$3,'k-10','sending',$4, now() + interval '2 minutes')`,
    [ids.projA, ids.mileA, ids.tester, ClaimPolicy.maxAttempts]);
  assert.equal((await parkExhaustedOutbox(db)).length, 0);
});
