import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const composePath = new URL('../docker-compose.yml', import.meta.url);

test('runtime is non-owner and permanent deletion is an explicit one-shot owner task', async () => {
  const compose = await readFile(composePath, 'utf8');

  assert.match(compose, /runtime-role:/,
    'Compose must provision the runtime login after migrations');
  assert.match(compose, /postgres:\/\/rgm_app:\$\{RGM_RUNTIME_PASSWORD\}@db:5432\/rgm/g);
  assert.doesNotMatch(compose,
    /(?:app:|worker:)[\s\S]*?DATABASE_URL: postgres:\/\/rgm:\$\{POSTGRES_PASSWORD\}@db:5432\/rgm/,
    'application services must not receive the database-owner login');
  assert.doesNotMatch(compose, /PURGE_DATABASE_URL|RGM_PURGER_PASSWORD|rgm_purge_app/,
    'hard purge must not add another long-lived login or credential');
  assert.match(compose,
    /admin:[\s\S]*<<:\s*\*owner-env[\s\S]*RGM_ADMIN_ONESHOT:\s*"true"[\s\S]*src\/cli\.js/,
    'permanent deletion must run only in an explicit one-shot owner container');
  assert.match(compose,
    /recover-admin:[\s\S]*profiles:\s*\["admin"\][\s\S]*environment:\s*\*owner-env[\s\S]*cleanup-storage\.mjs/,
    'recovery cleanup must use an explicit one-shot owner service');
});

test('the long-running worker verifies its live database role before polling', async () => {
  const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
  const verify = worker.indexOf('await verifyDatabaseRoleBoundary');
  const start = worker.indexOf('startWorkerLoop(db');
  assert.ok(verify >= 0 && verify < start,
    'worker must fail closed on owner or privileged credentials before polling');
});
