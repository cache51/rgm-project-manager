import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/recover.sh');

async function fixture({ restoreExit = 0, tocExit = 0, validationExit = 0,
  keepMatchCount = 1, validationDropExit = 0, cleanupExit = 0, dbRunning = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rgm-recover-test-'));
  const bin = join(dir, 'bin');
  await import('node:fs/promises').then(fs => fs.mkdir(bin));
  const log = join(dir, 'docker.log');
  const dump = join(dir, 'snapshot.dump');
  await writeFile(dump, 'not read by the fake docker');
  await writeFile(join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$*" == *"pg_restore -l"* ]]; then exit "${tocExit}"; fi
if [[ "$*" == *"pg_restore"* && "$*" == *"_restore_check_"* ]]; then exit "${validationExit}"; fi
if [[ "$*" == *"pg_restore"* && "$*" == *"--use-list"* ]]; then exit "${restoreExit}"; fi
if [[ "$*" == *"SELECT count(*)::int FROM projects WHERE id IN"* ]]; then echo "${keepMatchCount}"; fi
if [[ "$*" == *"SELECT count(*)::int FROM projects;"* ]]; then echo "${keepMatchCount}"; fi
if [[ "$*" == *"SELECT 1 FROM schema_migrations"* ]]; then echo 1; fi
if [[ "$*" == *"DROP DATABASE IF EXISTS"* && "$*" == *"_restore_check_"* ]]; then exit "${validationDropExit}"; fi
if [[ "$*" == *"recover-admin"* ]]; then exit "${cleanupExit}"; fi
if [[ "$*" == *"ps --status running --services db"* ]]; then
  ${dbRunning ? 'echo db' : ':'}
fi
if [[ "$*" == *"psql"* && "$*" != *" -c "* ]]; then cat >> "$FAKE_DOCKER_LOG"; fi
exit 0
`);
  await chmod(join(bin, 'docker'), 0o755);
  return { dir, bin, dump, log, env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    RGM_HEALTH_URL: '',
    RGM_COMPOSE_PROJECT: 'unit-test',
  } };
}

function run(args, env) {
  return new Promise(resolveRun => {
    const child = spawn('bash', [script, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('recover refuses to touch the database without exact confirmation', async () => {
  const f = await fixture();
  const result = await run([f.dump], f.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--confirm-drop-database rgm/);
  await assert.rejects(readFile(f.log, 'utf8'), { code: 'ENOENT' });
});

test('keep-project requires an explicit recovery actor before database work', async () => {
  const f = await fixture();
  const result = await run([
    f.dump,
    '--confirm-drop-database', 'rgm',
    '--keep-project', '11111111-1111-4111-8111-111111111111',
  ], f.env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--actor-email <site-admin-email>/);
  await assert.rejects(readFile(f.log, 'utf8'), { code: 'ENOENT' });
});

test('recover uses a filtered TOC and fail-fast pg_restore', async () => {
  const f = await fixture();
  const result = await run([
    f.dump,
    '--confirm-drop-database', 'rgm',
    '--actor-email', 'recovery-admin@rgm.example',
    '--keep-project', '11111111-1111-4111-8111-111111111111',
  ], f.env);
  assert.equal(result.code, 0, result.stderr);
  const log = await readFile(f.log, 'utf8');
  assert.match(log, /pg_restore -l/);
  assert.doesNotMatch(log, /compose -p unit-test up -d db/,
    'preflight must not recreate an already-running database container');
  assert.match(log, /pg_restore .*--data-only .*--use-list=\/tmp\/rgm-recover-[0-9]+\.list/);
  assert.match(log, /pg_restore .*--exit-on-error/);
  assert.equal((log.match(/pg_restore .*--data-only .*--use-list/g) ?? []).length, 2,
    'validation and production must run the same filtered data restore');
  const validationMigration = log.indexOf('RGM_RECOVER_DB=rgm_restore_check_');
  const stopWriters = log.indexOf('compose -p unit-test stop app worker');
  assert.ok(validationMigration >= 0 && validationMigration < stopWriters,
    'current migrations and filtered data restore must be proven before stopping writers');
  assert.doesNotMatch(log, /--exclude-table/);
  assert.match(log, /11111111-1111-4111-8111-111111111111/);
  assert.match(log, /actor_email=recovery-admin@rgm\.example/);
  assert.match(log, /actor_email := current_setting\('rgm\.recovery_actor_email'\)/,
    'the supplied actor email must be passed to the guarded purge function');
  assert.doesNotMatch(log, /is_site_admin = true ORDER BY/,
    'recovery must never attribute pruning to an arbitrary administrator');
  assert.match(log, /admin_purge_project/,
    'excluded projects must use the same durable object-cleanup path as hard purge');
  assert.match(log, /compose -p unit-test run --rm -T --no-deps recover-admin/);
  assert.match(log, /rm -f \/tmp\/rgm-recover-[0-9]+\.dump/);
  assert.match(log, /compose -p unit-test up -d app worker/);
});

test('a well-formed keep-project typo is rejected before destructive work', async () => {
  const f = await fixture({ keepMatchCount: 0 });
  const result = await run([
    f.dump,
    '--confirm-drop-database', 'rgm',
    '--actor-email', 'recovery-admin@rgm.example',
    '--keep-project', '11111111-1111-4111-8111-111111111111',
  ], f.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requested keep-project UUID was not found/i);
  const log = await readFile(f.log, 'utf8');
  assert.doesNotMatch(log, /compose -p unit-test stop app worker/);
  assert.doesNotMatch(log, /DROP DATABASE IF EXISTS "rgm"/);
});

test('validation database cleanup is mandatory before destructive work', async () => {
  const f = await fixture({ validationDropExit: 6 });
  const result = await run([f.dump, '--confirm-drop-database', 'rgm'], f.env);
  assert.equal(result.code, 6, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /could not remove validation database/i);
  const log = await readFile(f.log, 'utf8');
  assert.doesNotMatch(log, /compose -p unit-test stop app worker/);
  assert.doesNotMatch(log, /DROP DATABASE IF EXISTS "rgm"/);
});

test('object cleanup failure is fatal and leaves the application stopped', async () => {
  const f = await fixture({ cleanupExit: 5 });
  const result = await run([f.dump, '--confirm-drop-database', 'rgm'], f.env);
  assert.equal(result.code, 5, `${result.stdout}\n${result.stderr}`);
  const log = await readFile(f.log, 'utf8');
  assert.match(log, /recover-admin/);
  assert.doesNotMatch(log, /compose -p unit-test up -d app worker/);
});

test('a second recovery is refused by the exclusive lock', async () => {
  const f = await fixture();
  const lock = '/tmp/rgm-recover-unit-test-rgm.lock';
  const fs = await import('node:fs/promises');
  await fs.mkdir(lock);
  try {
    const result = await run([f.dump, '--confirm-drop-database', 'rgm'], f.env);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /another RGM recovery is already running/);
    await assert.rejects(readFile(f.log, 'utf8'), { code: 'ENOENT' });
  } finally {
    await fs.rmdir(lock);
  }
});

test('a pg_restore error is fatal and leaves the application stopped', async () => {
  const f = await fixture({ restoreExit: 7 });
  const result = await run([f.dump, '--confirm-drop-database', 'rgm'], f.env);
  assert.equal(result.code, 7, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /FATAL: pg_restore failed/);
  const log = await readFile(f.log, 'utf8');
  assert.doesNotMatch(log, /compose -p unit-test up -d app worker/);
  assert.doesNotMatch(log, /ALTER TABLE events DISABLE/);
});

test('an unreadable snapshot is rejected before stopping writers or dropping the database', async () => {
  const f = await fixture({ tocExit: 9 });
  const result = await run([f.dump, '--confirm-drop-database', 'rgm'], f.env);
  assert.equal(result.code, 9, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /cannot read snapshot TOC/);
  const log = await readFile(f.log, 'utf8');
  assert.doesNotMatch(log, /compose -p unit-test stop app worker/);
  assert.doesNotMatch(log, /DROP DATABASE/);
  assert.doesNotMatch(log, /compose -p unit-test run --rm -T --no-deps migrate/);
});

test('a corrupt data block is rejected by a full disposable restore before the live database is dropped', async () => {
  const f = await fixture({ validationExit: 8 });
  const result = await run([f.dump, '--confirm-drop-database', 'rgm'], f.env);
  assert.equal(result.code, 8, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /full snapshot validation failed/);
  const log = await readFile(f.log, 'utf8');
  assert.match(log, /CREATE DATABASE .*_restore_check_/);
  assert.match(log, /pg_restore .*_restore_check_/);
  assert.doesNotMatch(log, /compose -p unit-test stop app worker/);
  assert.doesNotMatch(log, /DROP DATABASE IF EXISTS "rgm"/);
});

test('health verification retries while the restarted app becomes ready', async () => {
  const f = await fixture();
  const attempts = join(f.dir, 'curl-attempts');
  await writeFile(join(f.bin, 'curl'), `#!/bin/bash
n=0
[ ! -f "$FAKE_CURL_ATTEMPTS" ] || n=$(cat "$FAKE_CURL_ATTEMPTS")
n=$((n + 1))
printf '%s' "$n" > "$FAKE_CURL_ATTEMPTS"
[ "$n" -ge 3 ]
`);
  await chmod(join(f.bin, 'curl'), 0o755);
  const env = {
    ...f.env,
    FAKE_CURL_ATTEMPTS: attempts,
    RGM_HEALTH_URL: 'http://127.0.0.1:3101/api/health',
    RGM_HEALTH_ATTEMPTS: '3',
    RGM_HEALTH_DELAY: '0',
  };
  const result = await run([f.dump, '--confirm-drop-database', 'rgm'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(attempts, 'utf8'), '3');
});
