/**
 * The MCP server itself: the protocol an agent speaks to it, and whether a
 * failure arrives as something the agent can read and act on rather than a
 * crash it has to guess about.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'rgm-mcp.mjs');

/** Start the server against a chosen environment and speak JSON-RPC to it. */
function session(env = {}, { cwd } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, RGM_URL: '', RGM_TOKEN: '', RGM_CONFIG: '/nonexistent/rgm.json', ...env },
    cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  const waiters = new Map();
  const errors = [];
  child.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = waiters.get(msg.id);
      if (resolve) { waiters.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.on('data', (d) => errors.push(String(d)));
  let id = 0;
  return {
    request(method, params) {
      const mine = ++id;
      const answer = new Promise((r) => waiters.set(mine, r));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
      return answer;
    },
    stop() { child.kill(); },
    errors
  };
}

describe('the rgm MCP server', () => {
  test('it introduces itself and offers the whole loop', async () => {
    const s = session();
    try {
      const init = await s.request('initialize', { protocolVersion: '2024-11-05' });
      assert.equal(init.result.serverInfo.name, 'rgm');
      assert.ok(init.result.capabilities.tools, 'it advertises tools');

      const list = await s.request('tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      // The loop, end to end: see the work, read a bug, get its screenshots, ask,
      // read the answer, say what changed, hand it back for verification.
      for (const tool of ['rgm_list_bugs', 'rgm_get_bug', 'rgm_get_packet',
                          'rgm_get_attachment', 'rgm_ask_question', 'rgm_get_questions',
                          'rgm_comment', 'rgm_mark_fixed']) {
        assert.ok(names.includes(tool), `missing tool: ${tool}`);
      }
      for (const tool of list.result.tools) {
        assert.ok(tool.inputSchema?.type === 'object', `${tool.name} declares a schema`);
      }
      // Marking fixed demands evidence: the agent says what proves it.
      const fixed = list.result.tools.find((t) => t.name === 'rgm_mark_fixed');
      assert.ok(fixed.inputSchema.required.includes('verified_by'),
        'rgm_mark_fixed requires the evidence, not just a number');
    } finally { s.stop(); }
  });

  test('a missing credential comes back as something the agent can act on', async () => {
    const s = session();
    try {
      const res = await s.request('tools/call', { name: 'rgm_list_bugs', arguments: {} });
      assert.equal(res.result.isError, true, 'reported as a tool error, not a crash');
      assert.match(res.result.content[0].text, /rgm login/,
        'and it says exactly how to fix it');
    } finally { s.stop(); }
  });

  test('marking a bug fixed without evidence is refused, and says what to do', async () => {
    const s = session();
    try {
      const res = await s.request('tools/call',
        { name: 'rgm_mark_fixed', arguments: { number: 1 } });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /verified_by is required/,
        'the agent is told the evidence is not optional');
      assert.match(res.result.content[0].text, /test that reproduces/,
        'and what to do about it');
    } finally { s.stop(); }
  });

  test('an unknown tool is a protocol error, and the server stays up', async () => {
    const s = session();
    try {
      const bad = await s.request('tools/call', { name: 'rgm_teleport', arguments: {} });
      assert.equal(bad.error.code, -32602);
      // Still serving: one bad call must not take the session down.
      const list = await s.request('tools/list', {});
      assert.ok(list.result.tools.length > 0);
    } finally { s.stop(); }
  });
});

// ── Which project the agent works (RGM4-003) ───────────────────────────────
describe('the project the agent works', () => {
  /** A stand-in for the app that records which project was asked for. */
  async function stubApp() {
    const { createServer } = await import('node:http');
    const seen = [];
    const server = createServer((req, res) => {
      const match = /^\/api\/projects\/([^/]+)\/bugs$/.exec(req.url);
      if (!match) { res.statusCode = 404; res.end('{}'); return; }
      seen.push(match[1]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        openCount: 1,
        bugs: [{ code: 'BUG-1', status: 'open', severity: 'high', kind: 'bug', bug_number: 1,
          isOpen: true, title_vi: 'Vì sao mã hàng NV311-AW22 không vào được lệnh' }]
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      stop: () => new Promise((r) => server.close(r))
    };
  }

  /** A checkout bound to a project, the way `rgm use` leaves one. */
  async function boundRepo(project) {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'rgm-mcp-repo-'));
    await mkdir(join(dir, '.rgm'), { recursive: true });
    await writeFile(join(dir, '.rgm', 'project.json'), JSON.stringify(project));
    return dir;
  }

  test('a bound checkout decides, not the environment or the machine', async () => {
    const app = await stubApp();
    const dir = await boundRepo({ id: 'p-warehouse', name: 'Fabric Warehouse' });
    const s = session({
      RGM_URL: app.url, RGM_TOKEN: 't',
      RGM_PROJECT_ID: 'p-elsewhere',                    // a stale selection elsewhere
      RGM_CONFIG: '/nonexistent/rgm.json'
    }, { cwd: dir });
    try {
      const res = await s.request('tools/call', { name: 'rgm_list_bugs', arguments: {} });
      const out = res.result.content[0].text;

      assert.deepEqual(app.seen, ['p-warehouse'],
        'bugs must come from the repository the agent is working in');
      assert.match(out, /project: Fabric Warehouse/, 'the agent is told which project it is on');
      assert.match(out, /\.rgm\/project\.json/, 'and where that answer came from');
      assert.match(out, /BUG-1/);
    } finally {
      s.stop();
      await app.stop();
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('without a binding, the environment decides and says so', async () => {
    const app = await stubApp();
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'rgm-mcp-plain-'));
    const s = session({
      RGM_URL: app.url, RGM_TOKEN: 't', RGM_PROJECT_ID: 'p-projection',
      RGM_CONFIG: '/nonexistent/rgm.json'
    }, { cwd: dir });
    try {
      const res = await s.request('tools/call', { name: 'rgm_list_bugs', arguments: {} });
      const out = res.result.content[0].text;

      assert.deepEqual(app.seen, ['p-projection']);
      assert.match(out, /from RGM_PROJECT_ID/, 'the fallback is named, not guessed at');
    } finally {
      s.stop();
      await app.stop();
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    }
  });
});