/**
 * Which project a directory works (RGM4-003).
 *
 * This failure has a history: `rgm use` wrote one machine-wide selection, so
 * working in a second repository fetched the first project's BUG-1 and wrote it
 * over the other project's packet. A repository is the unit of work, so its own
 * binding answers first — and these tests pin the order down without the app.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'rgm-cli-project-'));
process.env.RGM_CONFIG = join(home, '.rgm', 'config.json');

const { resolveProject, findRepoBinding, writeBinding, repoRoot, saveConfig, run } =
  await import('../src/cli.js');

after(async () => { await rm(home, { recursive: true, force: true }); });

/** A checkout, optionally with a binding and a few directories to walk up from. */
async function repo(name, project, { depth = 0 } = {}) {
  const root = join(home, name);
  await mkdir(join(root, '.rgm'), { recursive: true });
  if (project) {
    await writeFile(join(root, '.rgm', 'project.json'), JSON.stringify(project));
  }
  let dir = root;
  for (let i = 0; i < depth; i++) {
    dir = join(dir, 'src');
    await mkdir(dir, { recursive: true });
  }
  return { root, dir };
}

const MACHINE = { projectId: 'p-projection', projectName: 'Projection Planning' };

test('the repository decides, not the last project selected on the machine', async () => {
  const { dir } = await repo('warehouse', { id: 'p-warehouse', name: 'Fabric Warehouse' });

  const resolved = await resolveProject({ cwd: dir, config: MACHINE, env: {} });

  assert.equal(resolved.id, 'p-warehouse',
    'a checkout must work its own project even when ~/.rgm/config.json says otherwise');
  assert.equal(resolved.name, 'Fabric Warehouse');
});

test('the binding is found from any depth inside the checkout', async () => {
  const { root, dir } = await repo('deep', { id: 'p-warehouse', name: 'Fabric Warehouse' },
    { depth: 3 });

  const resolved = await resolveProject({ cwd: dir, config: MACHINE, env: {} });

  assert.equal(resolved.id, 'p-warehouse');
  assert.equal(resolved.boundAt, root, 'the binding is reported where it was found');
});

test('the nearest binding wins when one checkout sits inside another', async () => {
  const { root } = await repo('outer', { id: 'p-outer', name: 'Outer' });
  const inner = join(root, 'vendor', 'inner');
  await mkdir(join(inner, '.rgm'), { recursive: true });
  await writeFile(join(inner, '.rgm', 'project.json'), JSON.stringify({ id: 'p-inner', name: 'Inner' }));

  const resolved = await resolveProject({ cwd: inner, config: MACHINE, env: {} });

  assert.equal(resolved.id, 'p-inner', 'the innermost repository is the one being worked in');
});

test('without a binding: the environment, then the machine-wide selection', async () => {
  const { dir } = await repo('plain', null);

  const fromEnv = await resolveProject({ cwd: dir, config: MACHINE, env: { RGM_PROJECT_ID: 'p-env' } });
  assert.equal(fromEnv.id, 'p-env');

  const fromConfig = await resolveProject({ cwd: dir, config: MACHINE, env: {} });
  assert.equal(fromConfig.id, 'p-projection');
  assert.equal(fromConfig.boundAt, undefined, 'nothing is bound, so nothing claims to be');
});

test('nothing configured resolves to null so the caller can say what to run', async () => {
  const { dir } = await repo('empty', null);

  assert.equal(await resolveProject({ cwd: dir, config: {}, env: {} }), null);
});

test('a binding without an id is ignored rather than guessed at', async () => {
  const { root, dir } = await repo('corrupt', null);
  await writeFile(join(root, '.rgm', 'project.json'), '{"name": "only a name"}');

  const resolved = await resolveProject({ cwd: dir, config: MACHINE, env: {} });

  assert.equal(resolved.id, 'p-projection', 'an unusable binding falls through, it does not invent one');
});

test('an unreadable binding is not a licence to guess either', async () => {
  const { root, dir } = await repo('broken', null);
  await writeFile(join(root, '.rgm', 'project.json'), '{not json at all');

  assert.equal((await resolveProject({ cwd: dir, config: MACHINE, env: {} })).id, 'p-projection');
  assert.equal(await findRepoBinding(dir), null);
});

test('writeBinding replaces a binding and reports the one it replaced', async () => {
  const { root } = await repo('replace', { id: 'p-old', name: 'Old' });

  const previous = await writeBinding(join(root, '.rgm'), { id: 'p-new', name: 'New' });

  assert.equal(previous.id, 'p-old');
  const written = JSON.parse(await readFile(join(root, '.rgm', 'project.json'), 'utf8'));
  assert.equal(written.id, 'p-new');
  assert.ok(written.boundAt, 'a binding records when it was written');
});

test('repoRoot finds the top of a checkout, and the directory when there is none', async () => {
  const { root, dir } = await repo('gitrepo', null, { depth: 1 });
  const { execFileSync } = await import('node:child_process');
  const { realpathSync } = await import('node:fs');
  execFileSync('git', ['init', '-q'], { cwd: root });

  // git answers with the physical path, and on macOS the temp dir is reached
  // through a symlink (/var -> /private/var), so compare like for like.
  assert.equal(repoRoot(dir), realpathSync(root), 'a binding belongs at the top of the checkout');

  const loose = await mkdtemp(join(tmpdir(), 'rgm-loose-'));
  assert.equal(repoRoot(loose), loose, 'outside a repository the directory is the unit');
  await rm(loose, { recursive: true, force: true });
});

test('`use` binds the repository it is run in', async () => {
  await saveConfig({ url: 'http://127.0.0.1:9', token: 't', projectId: null });
  const { root } = await repo('used', null);
  const cwd = process.cwd();

  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ projects: [{ id: 'p-warehouse', name: 'Fabric Warehouse' }] })
  });

  try {
    process.chdir(root);
    const out = await run(['use', 'Fabric Warehouse']);

    assert.match(out, /bound .*\.rgm\/project\.json/,
      'the command says which repository it bound, not just which project it selected');
    const written = JSON.parse(await readFile(join(root, '.rgm', 'project.json'), 'utf8'));
    assert.equal(written.id, 'p-warehouse');
  } finally {
    process.chdir(cwd);
    globalThis.fetch = fetchBefore;
  }
});

test('a project named at the call beats the repository binding', async () => {
  await saveConfig({ url: 'http://127.0.0.1:9', token: 't', projectId: null });
  const { root } = await repo('named', { id: 'p-warehouse', name: 'Fabric Warehouse' });
  const cwd = process.cwd();

  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ projects: [{ id: 'p-other', name: 'Project Other' }] })
  });

  try {
    process.chdir(root);
    const out = await run(['project', '--project', 'Project Other']);

    assert.match(out, /^Project Other\s+\(p-other\)/, 'the named project is the one reported');
    assert.match(out, /from --project/, 'and it says the answer came from the call');
  } finally {
    process.chdir(cwd);
    globalThis.fetch = fetchBefore;
  }
});

test('resolveProject: an explicit project wins over every other source', async () => {
  const { dir } = await repo('explicit', { id: 'p-warehouse', name: 'Fabric Warehouse' });

  const resolved = await resolveProject({
    cwd: dir,
    config: MACHINE,
    env: { RGM_PROJECT_ID: 'p-env' },
    explicit: { id: 'p-other', name: 'Project Other' }
  });

  assert.equal(resolved.id, 'p-other');
  assert.equal(resolved.source, 'argument',
    'the one piece of evidence that is not an inference is the name given at the call');
});

test('`use --global` means the machine, and leaves the repository alone', async () => {
  await saveConfig({ url: 'http://127.0.0.1:9', token: 't', projectId: null });
  const { root } = await repo('global', null);
  const cwd = process.cwd();

  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ projects: [{ id: 'p-projection', name: 'Projection Planning' }] })
  });

  try {
    process.chdir(root);
    await run(['use', 'Projection Planning', '--global']);

    await assert.rejects(access(join(root, '.rgm', 'project.json')),
      'a global selection must not leave a binding behind');
  } finally {
    process.chdir(cwd);
    globalThis.fetch = fetchBefore;
  }
});