/** `rgm admin delete-project` — host-authorized, with no browser token or password. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers.js';
import { run as runCli } from '../src/cli.js';
import { purgeProject } from '../src/admin-purge.js';

let w, targetProjectId, guardedProjectId;

function run(args) {
  return runCli(args, {
    adminDelete: (input) => purgeProject({
      ...input, db: w.db, storage: w.storage, onError: () => {}
    })
  });
}

describe('rgm admin delete-project', () => {
  before(async () => {
    const { bootstrap } = await import('../src/auth.js');
    w = await makeWorld();
    await bootstrap(w.db, 'admin@rgm.example');
    const adminClient = await w.loginAs('admin@rgm.example');
    targetProjectId = (await adminClient.post('/api/projects',
      { name: 'CLI purge target', client: 'RGM', env: 'staging' })).json.id;
    guardedProjectId = (await adminClient.post('/api/projects',
      { name: 'CLI guarded target', client: 'RGM', env: 'staging' })).json.id;
  });

  after(async () => { if (w) await w.close(); });

  test('refuses missing actor email, reason, and short reasons before database work', async () => {
    await assert.rejects(
      runCli(['admin', 'delete-project', targetProjectId, '--reason', 'long enough reason'],
        { adminDelete: async () => assert.fail('must not call adminDelete') }),
      /--actor-email/);
    await assert.rejects(
      run(['admin', 'delete-project', targetProjectId, '--actor-email', 'admin@rgm.example']),
      /delete-project needs --reason/);
    await assert.rejects(
      run(['admin', 'delete-project', targetProjectId, '--actor-email', 'admin@rgm.example',
        '--reason', 'too short']),
      /at least 12 characters/);
    await assert.rejects(
      run(['admin', 'delete-project', '../wrong-project', '--actor-email', 'admin@rgm.example',
        '--reason', 'long enough reason text']),
      /project id must be a UUID/);
  });

  test('without --force, a live project is not changed', async () => {
    await assert.rejects(
      run(['admin', 'delete-project', guardedProjectId,
        '--actor-email', 'admin@rgm.example', '--reason', 'must already be archived first']),
      /already-removed|archive it first/);
    const row = await w.db.query('SELECT deleted_at FROM projects WHERE id = $1', [guardedProjectId]);
    assert.equal(row.rows[0].deleted_at, null);
  });

  test('purges through the one-shot handler without loading API-token configuration', async () => {
    const output = await run(['admin', 'delete-project', targetProjectId,
      '--actor-email', 'admin@rgm.example',
      '--reason', 'integration test, was never real', '--force']);
    assert.match(output, /purged CLI purge target/);
    assert.match(output, /integration test, was never real/);
    const project = await w.db.query('SELECT id FROM projects WHERE id = $1', [targetProjectId]);
    assert.equal(project.rows.length, 0);
    const audit = await w.db.query(
      `SELECT target_name, reason FROM admin_audit_log WHERE target_id = $1`, [targetProjectId]);
    assert.deepEqual(audit.rows[0], {
      target_name: 'CLI purge target', reason: 'integration test, was never real'
    });
  });
});
