/**
 * A roster pasted in one go.
 *
 * The case that prompted this: six addresses copied out of a chat, one of them with a
 * name after a dash, added one dialog at a time — which is the job that gets deferred
 * and leaves the roster wrong.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld } from './helpers.js';

const EMAILS = ['yang@rgm.example', 'thibinh@rgm.example', 'duyvi@rgm.example',
  'muahang1@rgm.example', 'muahang2@rgm.example', 'acc02@rgm.example'];
const PASTE = [...EMAILS.slice(0, 5), 'acc02@rgm.example  - Hien'].join('\n');

const roster = async (client, projectId) =>
  (await client.get(`/api/projects/${projectId}/members`)).json.members;

describe('adding people from a pasted list', () => {
  test('the whole list goes in one request, names included', async () => {
    const w = await makeProjectWorld();
    try {
      const res = await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { people: PASTE, role: 'tester' });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.added.length, 6);
      assert.deepEqual(res.json.skipped, []);

      const members = await roster(w.adminClient, w.project.id);
      for (const email of EMAILS) {
        const m = members.find((x) => x.email === email);
        assert.ok(m, `${email} is on the roster`);
        assert.equal(m.role, 'tester');
      }
      const hien = members.find((x) => x.email === 'acc02@rgm.example');
      assert.equal(hien.displayName ?? hien.display_name, 'Hien',
        'the name beside the address is the name on the roster');
    } finally { await w.close(); }
  });

  test('one unusable line does not cost the others, and it is named', async () => {
    const w = await makeProjectWorld();
    try {
      // An address-shaped line with no domain: `kphai@localhost` has an @, so it is
      // meant as an address and is refused as one. A line with no @ at all is a NAME
      // (see the test below), which is the one thing this parser must not guess wrong.
      const res = await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { people: 'a@rgm.example\nkphai@localhost\nb@rgm.example', role: 'tester' });
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(res.json.added.map((m) => m.email), ['a@rgm.example', 'b@rgm.example']);
      assert.deepEqual(res.json.skipped,
        [{ email: 'kphai@localhost', reason: 'not an email address' }]);

      const members = await roster(w.adminClient, w.project.id);
      assert.ok(members.some((m) => m.email === 'a@rgm.example'), 'the good ones are in');
      assert.ok(!members.some((m) => m.email === 'kphai@localhost'), 'and the bad one is not');
    } finally { await w.close(); }
  });

  test('a word beside an address is the person\'s name, not a failed address', async () => {
    const w = await makeProjectWorld();
    try {
      const res = await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { people: 'hien@rgm.example, Hien\nbo@rgm.example - Bộ', role: 'tester' });
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(res.json.skipped, [], 'nothing here is unusable');

      const members = await roster(w.adminClient, w.project.id);
      const named = (email) => {
        const m = members.find((x) => x.email === email);
        return m?.displayName ?? m?.display_name;
      };
      assert.equal(named('hien@rgm.example'), 'Hien');
      assert.equal(named('bo@rgm.example'), 'Bộ', 'a diacritic name survives untouched');
    } finally { await w.close(); }
  });

  test('a paste with nothing usable in it is refused, not silently accepted', async () => {
    const w = await makeProjectWorld();
    try {
      const res = await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { people: 'hôm nay không có ai', role: 'tester' });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.error, 'no_members');
    } finally { await w.close(); }
  });

  test('pasting the same list again adds nobody twice, and can change the role', async () => {
    const w = await makeProjectWorld();
    try {
      await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { people: PASTE, role: 'tester' });
      const before = (await roster(w.adminClient, w.project.id)).length;

      await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { people: PASTE, role: 'tester' });
      assert.equal((await roster(w.adminClient, w.project.id)).length, before,
        'a second paste is not a second person');

      // The same list with a different role is how someone is promoted, so it must
      // take effect rather than being skipped as a duplicate.
      await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { people: PASTE, role: 'developer' });
      const members = await roster(w.adminClient, w.project.id);
      assert.equal(members.find((m) => m.email === 'yang@rgm.example').role, 'developer');
    } finally { await w.close(); }
  });

  test('only an admin may add people', async () => {
    const w = await makeProjectWorld();
    try {
      const res = await w.testerClient.post(`/api/projects/${w.project.id}/members`,
        { people: PASTE, role: 'tester' });
      assert.equal(res.status, 403, res.text);
      assert.equal((await roster(w.adminClient, w.project.id))
        .some((m) => m.email === 'yang@rgm.example'), false, 'and nobody was added');
    } finally { await w.close(); }
  });

  test('one address at a time still works, for the callers that do that', async () => {
    const w = await makeProjectWorld();
    try {
      const res = await w.adminClient.post(`/api/projects/${w.project.id}/members`,
        { email: 'solo@rgm.example', name: 'Solo', role: 'developer' });
      assert.equal(res.status, 201, res.text);
      const m = (await roster(w.adminClient, w.project.id))
        .find((x) => x.email === 'solo@rgm.example');
      assert.equal(m.role, 'developer');
      assert.equal(m.displayName ?? m.display_name, 'Solo');
    } finally { await w.close(); }
  });
});