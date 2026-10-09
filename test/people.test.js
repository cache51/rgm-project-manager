/**
 * What a person pastes into the roster form, and what it becomes.
 *
 * The case that matters is the one that prompted this: six addresses copied out of a
 * chat, one of them with a name after a dash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeople, MAX_PEOPLE_PER_CALL } from '../src/people.js';

test('the list he actually pasted', () => {
  const pasted = [
    'yang@rgmdn.com',
    'thibinh@rgmdn.com',
    'duyvi@rgmdn.com',
    'muahang1@rgmdn.com',
    'muahang2@rgmdn.com',
    'acc02@rgmdn.com  - Hien'
  ].join('\n');

  assert.deepEqual(parsePeople(pasted), [
    { email: 'yang@rgmdn.com', name: null },
    { email: 'thibinh@rgmdn.com', name: null },
    { email: 'duyvi@rgmdn.com', name: null },
    { email: 'muahang1@rgmdn.com', name: null },
    { email: 'muahang2@rgmdn.com', name: null },
    { email: 'acc02@rgmdn.com', name: 'Hien' }
  ]);
});

test('names survive the shapes people write them in', () => {
  assert.deepEqual(parsePeople('a@x.com - Thị Bình'), [{ email: 'a@x.com', name: 'Thị Bình' }]);
  assert.deepEqual(parsePeople('a@x.com: Thị Bình'), [{ email: 'a@x.com', name: 'Thị Bình' }]);
  assert.deepEqual(parsePeople('a@x.com\tThị Bình'), [{ email: 'a@x.com', name: 'Thị Bình' }]);
  assert.deepEqual(parsePeople('Thị Bình a@x.com'), [{ email: 'a@x.com', name: 'Thị Bình' }]);
  // A bare word on its own line names the line before it, which is how a paste of
  // "address, name" pairs reads.
  assert.deepEqual(parsePeople('a@x.com\nHien\nb@x.com'), [
    { email: 'a@x.com', name: 'Hien' },
    { email: 'b@x.com', name: null }
  ]);
});

test('commas, semicolons and spaces all separate a pasted list', () => {
  assert.deepEqual(parsePeople('a@x.com, b@x.com; c@x.com').map((p) => p.email),
    ['a@x.com', 'b@x.com', 'c@x.com']);
  assert.deepEqual(parsePeople('a@x.com b@x.com').map((p) => p.email),
    ['a@x.com', 'b@x.com'], 'two addresses on one line are two people, not one name');
});

test('a repeated address is added once, and keeps any name it was given', () => {
  assert.deepEqual(parsePeople('a@x.com\na@x.com\nA@X.COM - Hien'),
    [{ email: 'a@x.com', name: 'Hien' }],
    'the first spelling wins, and the name is not lost to the repeat');
});

test('an array of addresses works the same as a paste', () => {
  assert.deepEqual(parsePeople(['a@x.com', 'b@x.com - B']), [
    { email: 'a@x.com', name: null },
    { email: 'b@x.com', name: 'B' }
  ]);
});

test('an address that is not an address is still just a name, never a member', () => {
  // "@" missing: nothing here may become a member, and nothing may throw.
  const parsed = parsePeople('khong-phai-email\n\na@x.com\n   \n');
  assert.deepEqual(parsed, [{ email: 'a@x.com', name: 'khong-phai-email' }]);
});

test('a paste larger than the cap is cut at the cap, not accepted', () => {
  const many = Array.from({ length: MAX_PEOPLE_PER_CALL + 20 }, (_, i) => `p${i}@x.com`).join('\n');
  assert.equal(parsePeople(many).length, MAX_PEOPLE_PER_CALL);
});

test('nothing pasted is nothing, not a crash', () => {
  for (const empty of ['', '   \n\n', null, undefined, []]) {
    assert.deepEqual(parsePeople(empty), []);
  }
});