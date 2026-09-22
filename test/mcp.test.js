/**
 * The MCP server itself: the protocol an agent speaks to it, and whether a
 * failure arrives as something the agent can read and act on rather than a
 * crash it has to guess about.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'rgm-mcp.mjs');

/** Start the server against a chosen environment and speak JSON-RPC to it. */
function session(env = {}, { cwd, roots } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, RGM_URL: '', RGM_TOKEN: '', RGM_CONFIG: '/nonexistent/rgm.json', ...env },
    cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  const waiters = new Map();
  const errors = [];
  const serverRequests = [];   // outbound requests the server made, in order
  child.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method && String(msg.id ?? '').startsWith('srv-')) {
        serverRequests.push(msg);
        if (msg.method === 'roots/list') {
          // The client answers with whatever repositories it was told about.
          const answer = roots === undefined
            ? { error: { code: -32601, message: 'unsupported' } }   // a client without roots
            : { result: { roots: roots.map((r) => ({ uri: `file://${encodeURI(r)}` })) } };
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer })}\n`);
        }
        continue;
      }
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
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    serverRequests,
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
                          'rgm_comment', 'rgm_remove_comment', 'rgm_mark_fixed']) {
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
  /**
   * Speak the handshake the real clients speak: initialize advertises the
   * client's capabilities, and `notifications/initialized` triggers the roots
   * poll before any tool can run.
   */
  async function open(env, opts = {}) {
    const s = session(env, opts);
    await s.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test-client', version: '0' },
      capabilities: opts.roots === undefined ? {} : { roots: {} }
    });
    s.notify('notifications/initialized', {});
    return s;
  }

  /** A stand-in for the app that records which project was asked for. */
  async function stubApp() {
    const { createServer } = await import('node:http');
    const seen = [];
    const server = createServer((req, res) => {
      if (req.url === '/api/projects') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ projects: [
          { id: 'p-warehouse', name: 'Fabric Warehouse' },
          { id: 'p-other', name: 'Project Other' }
        ] }));
        return;
      }
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

  /** Temp directories, cleaned in one sweep after this suite. */
  const tempDirs = [];
  const mkTmp = async (prefix) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  after(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** A checkout bound to a project, the way `rgm use` leaves one. */
  async function boundRepo(project, name = 'repo') {
    const base = await mkTmp(`rgm-mcp-${name}-`);
    const dir = join(base, name);
    await mkdir(join(dir, '.rgm'), { recursive: true });
    await writeFile(join(dir, '.rgm', 'project.json'), JSON.stringify(project));
    return dir;
  }

  test('a bound checkout decides, not the environment or the machine', async () => {
    const app = await stubApp();
    const dir = await boundRepo({ id: 'p-warehouse', name: 'Fabric Warehouse' });
    // No roots advertised: an older or plain client, and the server must keep
    // working off its own process directory exactly as before.
    const s = await open({
      RGM_URL: app.url, RGM_TOKEN: 't',
      RGM_PROJECT_ID: 'p-elsewhere',                    // a stale selection elsewhere
      RGM_CONFIG: '/nonexistent/rgm.json'
    }, { cwd: dir });
    try {
      const res = await s.request('tools/call', { name: 'rgm_list_bugs', arguments: {} });
      const out = res.result.content[0].text;

      assert.deepEqual(s.serverRequests.filter((r) => r.method === 'roots/list'), [],
        'a client that never advertised roots is never asked');
      assert.deepEqual(app.seen, ['p-warehouse'],
        'bugs must come from the repository the agent is working in');
      assert.match(out, /project: Fabric Warehouse/, 'the agent is told which project it is on');
      assert.match(out, /\.rgm\/project\.json/, 'and where that answer came from');
      assert.match(out, /BUG-1/);
    } finally {
      s.stop();
      await app.stop();
    }
  });

  test('without a binding, the environment decides and says so', async () => {
    const app = await stubApp();
    const dir = await mkTmp('rgm-mcp-plain-');
    const s = await open({
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
    }
  });

  test('the session repository is found over MCP roots, not the server cwd', async () => {
    const app = await stubApp();
    // The plugin's server process is launched from a directory with no binding
    // at all (the harness's own), while the *session* sits in a bound checkout —
    // exactly the production situation that made the binding useless in Claude.
    const plain = await mkTmp('rgm-mcp-plain-');
    const sessionRepo = await boundRepo({ id: 'p-warehouse', name: 'Fabric Warehouse' });
    const s = await open({
      RGM_URL: app.url, RGM_TOKEN: 't',
      RGM_PROJECT_ID: 'p-elsewhere',                    // a stale machine-wide pick
      RGM_CONFIG: '/nonexistent/rgm.json'
    }, { cwd: plain, roots: [sessionRepo] });
    try {
      const res = await s.request('tools/call', { name: 'rgm_list_bugs', arguments: {} });
      const out = res.result.content[0].text;

      assert.ok(s.serverRequests.some((r) => r.method === 'roots/list'),
        'a client that advertises roots is asked for them');
      assert.deepEqual(app.seen, ['p-warehouse'],
        'the session repository decides, wherever the server process happens to run');
      assert.match(out, /\(the session repository\)/, 'and the agent is told it came from there');
    } finally {
      s.stop();
      await app.stop();
    }
  });

  test('a session path with Vietnamese characters survives the file URI', async () => {
    const app = await stubApp();
    const plain = await mkdtemp(join(tmpdir(), 'rgm-mcp-plain-'));
    // The real user directories look like this; a naive slice() of the file://
    // prefix leaves %C3%A2... behind and the binding is simply never found.
    const sessionRepo = await boundRepo(
      { id: 'p-warehouse', name: 'Fabric Warehouse' }, 'Dự Án 2026');
    const s = await open({
      RGM_URL: app.url, RGM_TOKEN: 't', RGM_CONFIG: '/nonexistent/rgm.json'
    }, { cwd: plain, roots: [sessionRepo] });
    try {
      await s.request('tools/call', { name: 'rgm_list_bugs', arguments: {} });
      assert.deepEqual(app.seen, ['p-warehouse'], 'percent-decoded, not half-decoded');
    } finally {
      s.stop();
      await app.stop();
    }
  });

  test('a session that offers several repositories prefers the first', async () => {
    const app = await stubApp();
    const plain = await mkTmp('rgm-mcp-plain-');
    const first = await boundRepo({ id: 'p-warehouse', name: 'Fabric Warehouse' }, 'first');
    const second = await boundRepo({ id: 'p-other', name: 'Project Other' }, 'second');
    const s = await open({
      RGM_URL: app.url, RGM_TOKEN: 't', RGM_CONFIG: '/nonexistent/rgm.json'
    }, { cwd: plain, roots: [first, second] });
    try {
      await s.request('tools/call', { name: 'rgm_list_bugs', arguments: {} });
      assert.deepEqual(app.seen, ['p-warehouse'],
        'the client ordered its roots; honouring that order beats inventing one');
    } finally {
      s.stop();
      await app.stop();
    }
  });

  test('a project named at the call beats the binding: one repo, several projects', async () => {
    const app = await stubApp();
    const dir = await boundRepo({ id: 'p-warehouse', name: 'Fabric Warehouse' });
    const s = await open({
      RGM_URL: app.url, RGM_TOKEN: 't', RGM_CONFIG: '/nonexistent/rgm.json'
    }, { cwd: dir });
    try {
      // The checkout belongs to Fabric Warehouse, but this call asks for another
      // project that lives in the same repository — a feature, not a directory.
      const res = await s.request('tools/call', {
        name: 'rgm_list_bugs', arguments: { project: 'Project Other' }
      });
      const out = res.result.content[0].text;

      assert.deepEqual(app.seen, ['p-other'], 'the named project is the one asked for');
      assert.match(out, /project: Project Other/, 'and the agent is told which one it got');
      assert.match(out, /from the project argument/, 'including that it came from the call');
    } finally {
      s.stop();
      await app.stop();
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a project argument that matches nothing is an error, never a guess', async () => {
    const app = await stubApp();
    const s = session({ RGM_URL: app.url, RGM_TOKEN: 't', RGM_CONFIG: '/nonexistent/rgm.json' });
    try {
      const res = await s.request('tools/call', {
        name: 'rgm_list_bugs', arguments: { project: 'No Such Project' }
      });

      assert.match(res.result.content[0].text, /no project matching No Such Project/,
        'a typo is reported, not silently resolved to the bound project');
      assert.deepEqual(app.seen, [], 'and nothing was fetched from any project');
    } finally {
      s.stop();
      await app.stop();
    }
  });
});

// ── Taking a comment back (018) ────────────────────────────────────────────
describe('the agent taking a comment back', () => {
  /**
   * A stub of the real app for this feature: one project, one bug, a comment the
   * tester wrote that has been answered (41, locked) and the agent's own that has
   * not (42, withdrawable), exactly as the server now marks them.
   */
  async function stub() {
    const { createServer } = await import('node:http');
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const send = (body, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/projects') {
        return send({ projects: [{ id: 'p-1', name: 'Fabric Warehouse', role: 'developer' }] });
      }
      if (req.url === '/api/projects/p-1/bugs/by-number/7') {
        return send({ id: 'b-1', code: 'BUG-7' });
      }
      if (req.url === '/api/bugs/b-1/prompt') {
        res.setHeader('content-type', 'text/plain');
        return res.end('# BUG-7\n');
      }
      if (req.url === '/api/bugs/b-1') {
        return send({
          status: 'fixing', severity: 'high', projectId: 'p-1', milestone: { code: 'M1' },
          availableActions: [], questions: { questions: [] }, attachments: [],
          timeline: [
            { id: 41, kind: 'bug.commented', actor: 'tester', canRemove: false, note: 'vẫn còn lỗi' },
            { id: 42, kind: 'bug.commented', actor: 'agent', canRemove: true, note: 'fixed in abc1234' }
          ]
        });
      }
      if (req.url === '/api/bugs/b-1/comments' && req.method === 'POST') {
        return send({ id: 99 }, 201);
      }
      if (req.url === '/api/bugs/b-1/comments/42' && req.method === 'DELETE') {
        return send({ ok: true, id: 42 });
      }
      if (req.url === '/api/bugs/b-1/comments/41' && req.method === 'DELETE') {
        return send({ error: 'comment_answered',
                      message: 'this comment has been answered by tester — it stays on the record' }, 409);
      }
      return send({ error: 'not_found' }, 404);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      stop: () => new Promise((r) => server.close(r))
    };
  }

  const call = (s, name, args) => s.request('tools/call', { name, arguments: args });

  // Not async: session() returns the handle directly, and a Promise here would make
  // every `s.request` below a TypeError — and the stub server would never be closed.
  const open = (url) => session({ RGM_URL: url, RGM_TOKEN: 't',
    RGM_CONFIG: '/nonexistent/rgm.json' });

  test('rgm_get_bug names the comments it may take back, and only those', async () => {
    const app = await stub();
    const s = open(app.url);
    try {
      const out = (await call(s, 'rgm_get_bug', { number: 7, project: 'Fabric Warehouse' }))
        .result.content[0].text;

      assert.match(out, /42: fixed in abc1234/, 'its own unanswered comment, with the id');
      assert.match(out, /rgm_remove_comment/, 'and the tool that acts on it');
      assert.doesNotMatch(out, /41: vẫn còn lỗi/,
        'the answered one is not offered — the server already said canRemove: false');
    } finally { s.stop(); await app.stop(); }
  });

  test('rgm_remove_comment deletes the comment it was given', async () => {
    const app = await stub();
    const s = open(app.url);
    try {
      const res = await call(s, 'rgm_remove_comment',
        { number: 7, comment_id: 42, project: 'Fabric Warehouse' });

      assert.notEqual(res.result.isError, true, res.result.content[0].text);
      assert.match(res.result.content[0].text, /removed comment 42/);
      assert.ok(app.seen.includes('DELETE /api/bugs/b-1/comments/42'),
        'it is a request to the app, not a local note to itself');
    } finally { s.stop(); await app.stop(); }
  });

  test('a refusal arrives as a sentence the agent can act on', async () => {
    const app = await stub();
    const s = open(app.url);
    try {
      const res = await call(s, 'rgm_remove_comment',
        { number: 7, comment_id: 41, project: 'Fabric Warehouse' });

      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /answered by tester/,
        'the agent is told why it is locked, not just that it failed');
    } finally { s.stop(); await app.stop(); }
  });

  test('rgm_comment reports the id, so a wrong note can be taken straight back', async () => {
    const app = await stub();
    const s = open(app.url);
    try {
      const res = await call(s, 'rgm_comment',
        { number: 7, note: 'fixed in abc1250', project: 'Fabric Warehouse' });
      assert.match(res.result.content[0].text, /comment 99/,
        'otherwise the agent has no way to name what it just wrote');
    } finally { s.stop(); await app.stop(); }
  });
});