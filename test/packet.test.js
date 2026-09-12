import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packetEntryName, packetEntryNames, packetSlug, packetArchiveName, extensionFor,
  isSafeRelativePath, assertSafeRelativePath, packetPathFor, buildPacketMeta,
  contentDisposition
} from '../src/packet.js';

test('packet entry names are server-assigned and zero-padded', () => {
  assert.equal(packetEntryName(1), 'screenshot_01.png');
  assert.equal(packetEntryName(12), 'screenshot_12.png');
  assert.deepEqual(packetEntryNames(3),
    ['screenshot_01.png', 'screenshot_02.png', 'screenshot_03.png']);
  assert.throws(() => packetEntryName(0), RangeError);
  assert.throws(() => packetEntryNames(-1), RangeError);
});

// ── RGM3-007: zip-slip ─────────────────────────────────────────────────────
const UNSAFE = [
  '../etc/passwd',
  '../../.git/hooks/pre-commit',
  'a/../../b.png',
  '/etc/passwd',
  'C:/Windows/system32/evil.dll',
  '\\\\server\\share\\evil.png',
  '~/.ssh/authorized_keys',
  'dir//file.png',
  './file.png',
  'nul\0byte.png',
  'back\\slash.png',
  '..',
  '.',
  ''
];

test('path guard rejects every traversal shape', () => {
  for (const p of UNSAFE) {
    assert.equal(isSafeRelativePath(p), false, `should reject: ${JSON.stringify(p)}`);
    assert.throws(() => assertSafeRelativePath(p), /unsafe packet entry path/);
  }
});

test('path guard accepts ordinary names', () => {
  for (const p of ['bug.md', 'meta.json', 'screenshot_01.png', 'a/b/c.png']) {
    assert.equal(isSafeRelativePath(p), true, `should accept: ${p}`);
    assert.equal(assertSafeRelativePath(p), p);
  }
});

test('packetPathFor refuses a traversal entry even under a valid base', () => {
  assert.equal(packetPathFor('/repo/.rgm/BUG-142', 'bug.md'), '/repo/.rgm/BUG-142/bug.md');
  assert.throws(() => packetPathFor('/repo/.rgm/BUG-142', '../../.git/config'));
  // trailing slash on the base is normalised, not doubled
  assert.equal(packetPathFor('/repo/.rgm/BUG-142/', 'bug.md'), '/repo/.rgm/BUG-142/bug.md');
});

test('a tester-supplied filename never becomes the archive name', () => {
  const hostile = '../../../../.bashrc';
  const name = packetArchiveName('BUG-142', 'Total carton count is wrong');
  assert.equal(name, 'BUG-142-total-carton-count-is-wrong.zip');
  assert.ok(!name.includes(hostile));
  // slug can never carry a separator or a leading dash
  assert.equal(packetSlug(hostile), 'bashrc');
  assert.equal(packetSlug('--exec=oops'), 'exec-oops');
  assert.equal(packetSlug(''), 'bug');
  assert.ok(!packetSlug(hostile).startsWith('-'));
});

test('a Vietnamese or Chinese title survives the slug — safety is not ascii-ness', () => {
  // Regression: restricting the slug to [a-z0-9] turned a Vietnamese title into
  // 's-l-ng-th-ng-kh-ng-...', which is useless to the developer reading it.
  assert.equal(packetSlug('Số lượng thùng không khớp'), 'số-lượng-thùng-không-khớp');
  assert.equal(packetSlug('紙箱數量驗證'), '紙箱數量驗證');
  assert.equal(packetArchiveName('BUG-1', 'Số lượng thùng'),
    'BUG-1-số-lượng-thùng.zip');

  // ...while separators, dots and dashes are still removed.
  assert.equal(packetSlug('a/b\\c'), 'a-b-c');
  assert.equal(packetSlug('../..'), 'bug');
  assert.equal(packetSlug('Số lượng/thùng 3'), 'số-lượng-thùng-3');
  assert.equal(packetSlug('-rm -rf /'), 'rm-rf');
  assert.ok(!packetSlug('-rm -rf /').startsWith('-'));
});

test('contentDisposition is RFC 6266: ascii fallback plus the encoded name', () => {
  const name = 'BUG-1-số-lượng-thùng.zip';
  const header = contentDisposition(name, 'BUG-1.zip');

  const quoted = /filename="([^"]*)"/.exec(header)[1];
  assert.ok(/^[\x20-\x7E]*$/.test(quoted), `the quoted form must be ascii, got ${quoted}`);
  assert.equal(quoted, 'BUG-1.zip');
  assert.ok(header.includes("filename*=UTF-8''" + encodeURIComponent(name)),
    'the utf-8 form must carry the real name');
  assert.ok(!header.includes(name), 'raw non-ascii must not sit in the header');
});

test('meta keeps the original filename as data, entry name as the path', () => {
  const meta = buildPacketMeta({
    bug: {
      id: 'BUG-142', severity: 'high', status: 'fixing', tester: 'Nguyễn Thị Hoa',
      createdAt: '2026-09-12T09:41:00Z', updatedAt: '2026-09-12T10:40:00Z',
      milestoneCode: 'M2'
    },
    project: { id: 'p1', name: 'Packing', client: 'Lucky Brand', env: 'staging' },
    attachments: [
      { filename: '../../evil.png', contentType: 'image/png' },
      { filename: 'Screen Shot 2026-09-12.png', contentType: 'image/png' }
    ]
  });

  assert.equal(meta.attachments.length, 2);
  // entry name is what touches the filesystem, and it is server-assigned
  assert.deepEqual(meta.attachments.map(a => a.name),
    ['screenshot_01.png', 'screenshot_02.png']);
  for (const a of meta.attachments) assert.equal(isSafeRelativePath(a.name), true);
  // the hostile original survives only as a string value
  assert.equal(meta.attachments[0].original_filename, '../../evil.png');
  assert.equal(isSafeRelativePath(meta.attachments[0].original_filename), false);
  // serialising the meta cannot introduce a path
  const json = JSON.stringify(meta);
  assert.ok(json.includes('../../evil.png'));
  assert.equal(meta.milestone, 'M2');
});

// ── RGM-S1-008: the extension follows the validated type, not a hard-coded .png ──
test('packet entry extension is derived from the content type', () => {
  assert.equal(packetEntryName(1, 'image/png'), 'screenshot_01.png');
  assert.equal(packetEntryName(1, 'image/jpeg'), 'screenshot_01.jpg');
  assert.equal(packetEntryName(1, 'image/webp'), 'screenshot_01.webp');
  // parameters and casing are tolerated
  assert.equal(packetEntryName(1, 'IMAGE/JPEG; charset=binary'), 'screenshot_01.jpg');
  // an unsupported type is refused rather than silently mislabelled
  assert.throws(() => packetEntryName(1, 'image/tiff'), /unsupported packet image type/);
  assert.throws(() => packetEntryName(1, 'application/pdf'), /unsupported packet image type/);
  assert.throws(() => packetEntryName(1, ''), /unsupported packet image type/);
  assert.equal(extensionFor('image/png'), 'png');
});

test('a mixed set of attachments gets matching extensions', () => {
  const names = packetEntryNames(3, ['image/png', 'image/jpeg', 'image/webp']);
  assert.deepEqual(names, ['screenshot_01.png', 'screenshot_02.jpg', 'screenshot_03.webp']);
});

test('RGM-S1-007: packet meta carries stable ids and the timeline association', () => {
  const meta = buildPacketMeta({
    bug: {
      id: 'BUG-142', severity: 'high', status: 'retest', tester: 'Hoa',
      createdAt: '2026-09-12T09:41:00Z', updatedAt: '2026-09-12T10:40:00Z'
    },
    project: { id: 'p1', name: 'Packing', client: 'Lucky Brand', env: 'staging' },
    attachments: [
      { id: 'att-1', filename: 'a.png', contentType: 'image/png',
        uploadedAt: '2026-09-12T09:41:10Z', eventId: 7 },
      { id: 'att-2', filename: 'b.jpeg', contentType: 'image/jpeg',
        uploadedAt: '2026-09-13T11:00:00Z', eventId: 12 }
    ]
  });
  assert.equal(meta.attachments[0].id, 'att-1');
  assert.equal(meta.attachments[0].attached_to_event, 7);
  assert.equal(meta.attachments[0].uploaded_at, '2026-09-12T09:41:10Z');
  assert.equal(meta.attachments[1].name, 'screenshot_02.jpg');
  // two screenshots from different retest cycles are distinguishable
  assert.notEqual(meta.attachments[0].attached_to_event,
                  meta.attachments[1].attached_to_event);
});
