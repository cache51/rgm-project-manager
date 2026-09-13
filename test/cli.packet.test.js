/**
 * The zip reader and the CLI's packet extraction.
 *
 * The deflate path is exercised against an archive produced by the system `zip`
 * binary, so the reader is validated by something other than our own writer.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, stat, lstat, symlink, mkdtemp, rm }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip, crc32 } from '../src/zip.js';
import { readZip } from '../src/unzip.js';
import { extractPacket, ensureIgnored } from '../src/cli.js';
import { makeProjectWorld, makeMilestone, fileBug, PNG_BYTES } from './helpers.js';

const run = promisify(execFile);

describe('packet extraction does not follow symlinks (IR-010)', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'rgm-symlink-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('a symlink planted at the destination does not overwrite its target', async () => {
    const precious = join(dir, 'precious.txt');
    await writeFile(precious, 'ORIGINAL');
    const target = join(dir, 'BUG-1');
    await mkdir(target, { recursive: true });
    // The attack: the path a packet wants to write already points elsewhere.
    await symlink(precious, join(target, 'bug.md'));

    const zip = Buffer.from(makeZip([{ name: 'bug.md', data: Buffer.from('from the packet') }]));
    await extractPacket(zip, target);

    assert.equal(await readFile(precious, 'utf8'), 'ORIGINAL',
      'the file outside the packet directory must be untouched');
    const stat = await lstat(join(target, 'bug.md'));
    assert.ok(!stat.isSymbolicLink(), 'the link must be replaced by a real file');
    assert.equal(await readFile(join(target, 'bug.md'), 'utf8'), 'from the packet');
  });

  test('a symlinked ancestor directory is refused outright', async () => {
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const target = join(dir, 'BUG-2');
    await mkdir(target, { recursive: true });
    // A directory entry inside the packet resolving through a symlink.
    await symlink(elsewhere, join(target, 'sub'));

    const zip = Buffer.from(makeZip([
      { name: 'sub/bug.md', data: Buffer.from('should not land') }
    ]));
    await assert.rejects(() => extractPacket(zip, target),
      /refusing to extract through the symlinked directory/);
    assert.equal((await readdir(elsewhere)).length, 0,
      'nothing may be written outside the packet directory');
  });

  test('a normal extraction still works, and can be re-run', async () => {
    const target = join(dir, 'BUG-3');
    const zip = Buffer.from(makeZip([
      { name: 'bug.md', data: Buffer.from('first') },
      { name: 'screenshot_01.png', data: PNG_BYTES }
    ]));
    assert.deepEqual(await extractPacket(zip, target), ['bug.md', 'screenshot_01.png']);

    // Re-pulling a packet overwrites its own files — that is the point of `pull`.
    const second = Buffer.from(makeZip([{ name: 'bug.md', data: Buffer.from('second') }]));
    await extractPacket(second, target);
    assert.equal(await readFile(join(target, 'bug.md'), 'utf8'), 'second');
  });
});

describe('pulled packets cannot be committed by accident (IR-035)', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'rgm-ignore-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('a .gitignore is created that ignores everything', async () => {
    const root = join(dir, '.rgm');
    await ensureIgnored(root);
    const contents = await readFile(join(root, '.gitignore'), 'utf8');
    assert.match(contents, /^\*$/m, 'the directory must ignore its whole contents');
  });

  test('an existing .gitignore is not clobbered', async () => {
    const root = join(dir, '.rgm2');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, '.gitignore'), '# mine\n');
    await ensureIgnored(root);
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), '# mine\n');
  });
});

describe('zip reader', () => {
  let dir;
  before(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    dir = await mkdtemp(join(tmpdir(), 'rgm-zip-'));
  });
  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  test('round-trips an archive produced by our own writer', () => {
    const files = [
      { name: 'bug.md', data: Buffer.from('hello') },
      { name: 'meta.json', data: Buffer.from('{"a":1}') },
      { name: 'screenshot_01.png', data: PNG_BYTES }
    ];
    const entries = readZip(Buffer.from(makeZip(files)));
    assert.deepEqual(entries.map(e => e.name), files.map(f => f.name));
    for (let i = 0; i < files.length; i++) {
      assert.ok(entries[i].data.equals(Buffer.from(files[i].data)), `content of ${files[i].name}`);
      assert.equal(entries[i].crc, crc32(Buffer.from(files[i].data)));
    }
  });

  test('reads a deflate archive produced by the system zip binary', async () => {
    const src = join(dir, 'deflate-src');
    await mkdir(join(src, 'nested'), { recursive: true });
    await writeFile(join(src, 'a.txt'), 'compress me '.repeat(200));
    await writeFile(join(src, 'nested', 'b.txt'), 'nested content');
    await run('zip', ['-r', '-9', join(dir, 'deflate.zip'), '.'], { cwd: src });

    const entries = readZip(await readFile(join(dir, 'deflate.zip')));
    // A standard zip tool records directories as their own entries; the reader is
    // faithful to the archive and the extractor is what ignores them.
    const names = entries.filter(e => !e.name.endsWith('/')).map(e => e.name).sort();
    assert.deepEqual(names, ['a.txt', 'nested/b.txt']);
    const a = entries.find(e => e.name === 'a.txt');
    assert.equal(a.method, 8, 'zip -9 should have deflated this entry');
    assert.equal(a.data.toString(), 'compress me '.repeat(200));
  });

  test('rejects a file that is not a zip', () => {
    assert.throws(() => readZip(Buffer.from('not a zip at all, really')), /not a zip archive/);
  });
});

describe('packet extraction', () => {
  let dir;
  before(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    dir = await mkdtemp(join(tmpdir(), 'rgm-extract-'));
  });
  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  test('extracts a well-formed packet into the target directory', async () => {
    const target = join(dir, 'BUG-1');
    const zip = Buffer.from(makeZip([
      { name: 'bug.md', data: Buffer.from('# Bug BUG-1') },
      { name: 'meta.json', data: Buffer.from('{}') },
      { name: 'screenshot_01.png', data: PNG_BYTES }
    ]));
    const written = await extractPacket(zip, target);
    assert.deepEqual(written, ['bug.md', 'meta.json', 'screenshot_01.png']);
    assert.equal(await readFile(join(target, 'bug.md'), 'utf8'), '# Bug BUG-1');
    assert.ok((await readFile(join(target, 'screenshot_01.png'))).equals(PNG_BYTES));
  });

  test('refuses to extract a traversing archive, and writes nothing at all', async () => {
    const target = join(dir, 'safe');
    const zip = Buffer.from(makeZip([
      { name: 'bug.md', data: Buffer.from('ok') },
      { name: '../../escaped.txt', data: Buffer.from('pwned') }
    ]));

    await assert.rejects(() => extractPacket(zip, target), /unsafe packet entry path/);

    // Validation happens before any write, so nothing was created — not even the
    // target directory. A partially-extracted packet is itself a hazard.
    await assert.rejects(() => stat(target), /ENOENT/);
    await assert.rejects(() => stat(join(dir, 'escaped.txt')), /ENOENT/);
  });

  test('extracts an archive that contains directory entries', async () => {
    // Real zip tools record directories as entries; refusing those would make
    // `rgm pull` fail on any packet not produced by our own writer.
    const src = join(dir, 'dirzip-src');
    await mkdir(join(src, 'nested'), { recursive: true });
    await writeFile(join(src, 'nested', 'b.txt'), 'nested content');
    await run('zip', ['-r', join(dir, 'dirzip.zip'), '.'], { cwd: src });

    const target = join(dir, 'dirzip-out');
    const written = await extractPacket(await readFile(join(dir, 'dirzip.zip')), target);
    assert.ok(written.includes('nested/b.txt'));
    assert.equal(await readFile(join(target, 'nested', 'b.txt'), 'utf8'), 'nested content');
  });

  test('refuses absolute paths and backslash separators', async () => {
    for (const name of ['/etc/shadow', 'C:\\Windows\\evil.dll', '..\\..\\evil']) {
      const zip = Buffer.from(makeZip([{ name, data: Buffer.from('x') }]));
      await assert.rejects(() => extractPacket(zip, join(dir, 'nope-' + Math.random())),
        /unsafe packet entry path/, `${name} must be refused`);
    }
  });
});

describe('cli: pull against a live server', () => {
  let w, bug;
  before(async () => {
    w = await makeProjectWorld();
    const ms = await makeMilestone(w.adminClient, w.project.id, 'M-CLI', 'CLI');
    bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });

    const presign = (await w.testerClient.post(`/api/bugs/${bug.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length })).json;
    await w.testerClient.put(presign.uploadUrl, PNG_BYTES);
    await w.testerClient.post(`/api/bugs/${bug.id}/attachments/complete`,
      { storageKey: presign.storageKey, uploadToken: presign.uploadToken, filename: 'ảnh.png' });
  });
  after(async () => { await w.close(); });

  test('rgm pull extracts the packet exactly as the server built it', async () => {
    // The CLI reads its config path from the environment at import time.
    const configPath = join(w.dir, 'rgm-config.json');
    process.env.RGM_CONFIG = configPath;
    const cli = await import(`../src/cli.js?cachebust=${Date.now()}`);

    const created = await w.devClient.post('/api/tokens',
      { name: 'cli', scopes: ['bug:read'] });
    await cli.saveConfig({ url: w.url, token: created.json.token, projectId: w.project.id });

    const outDir = join(w.dir, 'pulled');
    const output = await cli.run(['pull', '1', '--out', outDir]);
    assert.match(output, /BUG-1/);

    const names = (await readdir(join(outDir, 'BUG-1'))).sort();
    assert.deepEqual(names, ['bug.md', 'meta.json', 'screenshot_01.png']);

    const prompt = await readFile(join(outDir, 'BUG-1', 'bug.md'), 'utf8');
    assert.match(prompt, /RGM-UNTRUSTED/);
    assert.match(prompt, /Thiếu hàng/);

    const meta = JSON.parse(await readFile(join(outDir, 'BUG-1', 'meta.json'), 'utf8'));
    assert.equal(meta.id, 'BUG-1');
    assert.equal(meta.attachments[0].original_filename, 'ảnh.png');
    assert.ok((await readFile(join(outDir, 'BUG-1', 'screenshot_01.png'))).equals(PNG_BYTES));
  });

  test('rgm prompt prints the handoff prompt to stdout', async () => {
    const cli = await import(`../src/cli.js?cachebust=${Date.now()}`);
    const text = await cli.run(['prompt', '1']);
    assert.match(text, /RGM-UNTRUSTED/);
    assert.match(text, /ATTACHMENTS/);
  });

  test('an unauthenticated CLI gets a clear failure, not a silent success', async () => {
    const cli = await import(`../src/cli.js?cachebust=${Date.now()}`);
    await cli.saveConfig({ url: w.url, token: 'not-a-real-token', projectId: w.project.id });
    await assert.rejects(() => cli.run(['bugs']), /401/);
  });
});
