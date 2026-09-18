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
function session(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, RGM_URL: '', RGM_TOKEN: '', RGM_CONFIG: '/nonexistent/rgm.json', ...env },
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