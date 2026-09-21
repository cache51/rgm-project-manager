/**
 * RGM_AGENT_EMAIL: a new project becomes visible to the coding agent the moment
 * it is created.
 *
 * The failure this guards is not a crash: a project the agent cannot see simply
 * has no bugs to work, and nothing says so — rgm-leave-app sat invisible to the
 * agent account for a full working day because membership is per project and
 * adding the agent was a manual step nobody remembered.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld } from './helpers.js';
import { createProject } from '../src/auth.js';

const AGENT = 'agent@rgm.example';

/** Sign the agent in the way agents actually sign in: the email-only direct
 *  route (no invite, no link) — that is what `directSignIn` in auth.js is for. */
async function agentClient(w) {
  const client = w.newClient();
  const res = await client.post('/api/auth/direct', { email: AGENT });
  if (res.status !== 200) throw new Error(`direct sign-in failed: ${res.text}`);
  return { client, visible: async () => (await client.get('/api/projects')).json.projects.map((p) => p.name) };
}

describe('a new project reaches the coding agent', () => {
  test('without the setting, nothing is granted (the default must stay closed)', async () => {
    const w = await makeProjectWorld();
    try {
      // The account exists — an agent that only ever got projects by hand is a
      // real configuration, and it must keep working unchanged.
      await w.db.query(`INSERT INTO users (email, display_name) VALUES ($1,'Coding agent')`,
        [AGENT]);
      const created = await w.adminClient.post('/api/projects', { name: 'Quiet Board' });
      assert.equal(created.status, 201);

      const agent = await agentClient(w);
      assert.deepEqual(await agent.visible(), [],
        'no RGM_AGENT_EMAIL, no auto-grant: a standing permission is not a default');
    } finally { await w.close(); }
  });

  test('with the setting, a project created through the API is agent-visible at once', async () => {
    const w = await makeProjectWorld({ agentEmail: AGENT });
    try {
      await w.db.query(`INSERT INTO users (email, display_name) VALUES ($1,'Coding agent')`,
        [AGENT]);

      const created = await w.adminClient.post('/api/projects', { name: 'Leave App' });
      assert.equal(created.status, 201);

      const agent = await agentClient(w);
      assert.deepEqual(await agent.visible(), ['Leave App'],
        'the board appears for the agent the moment it appears at all');

      // Developer, not more: the auto-grant must not hand out admin.
      const role = await w.db.query(
        `SELECT m.role FROM memberships m JOIN projects p ON p.id = m.project_id
           JOIN users u ON u.id = m.user_id
          WHERE p.name = 'Leave App' AND u.email = $1`, [AGENT]);
      assert.equal(role.rows[0].role, 'developer');

      const ev = await w.db.query(
        `SELECT kind, payload FROM events e JOIN projects p ON p.id = e.project_id
          WHERE p.name = 'Leave App' AND e.kind = 'membership.auto_added'`);
      assert.equal(ev.rows.length, 1, 'the grant is on the timeline, not invisible');
      // PGlite hands back a parsed object, node-postgres a string.
      const payload = typeof ev.rows[0].payload === 'string'
        ? JSON.parse(ev.rows[0].payload) : ev.rows[0].payload;
      assert.equal(payload.via, 'RGM_AGENT_EMAIL', 'and says where it came from');
    } finally { await w.close(); }
  });

  test('the agent creating its own project is not demoted to developer', async () => {
    // Route-level, project creation is a site-admin act — but the guard lives in
    // createProject, and it must hold however the project came to exist (an
    // agent account promoted to site admin, or the rule changing later).
    const w = await makeProjectWorld({ agentEmail: AGENT });
    try {
      await w.db.query(`INSERT INTO users (email, display_name) VALUES ($1,'Coding agent')`,
        [AGENT]);
      const agentRow = await w.db.query(`SELECT id FROM users WHERE email = $1`, [AGENT]);

      await createProject(w.db, { name: 'Agent Board', createdBy: agentRow.rows[0].id,
                                  agentEmail: AGENT });

      const role = await w.db.query(
        `SELECT m.role FROM memberships m JOIN projects p ON p.id = m.project_id
           JOIN users u ON u.id = m.user_id
          WHERE p.name = 'Agent Board' AND u.email = $1`, [AGENT]);
      assert.equal(role.rows[0].role, 'admin',
        'DO NOTHING, never DO UPDATE: the creator keeps the admin it already holds');
    } finally { await w.close(); }
  });

  test('an agent account that does not exist fails the grant quietly, never the creation', async () => {
    // The setting naming a since-deleted address must not brick project creation.
    const w = await makeProjectWorld({ agentEmail: 'nobody@rgm.example' });
    try {
      const created = await w.adminClient.post('/api/projects', { name: 'Fine Board' });
      assert.equal(created.status, 201);
      const count = await w.db.query(
        `SELECT count(*)::int AS n FROM projects WHERE name = 'Fine Board'`);
      assert.equal(count.rows[0].n, 1);
    } finally { await w.close(); }
  });
});
