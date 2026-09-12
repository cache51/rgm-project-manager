/**
 * Seed a demo database: one project with a ready milestone, two bugs (one with
 * screenshots), translations, and a pending-then-delivered notification.
 *
 *   node scripts/seed-demo.mjs
 *
 * Prints sign-in URLs for both a tester and a developer so the UI can be opened
 * as either. Screenshots are real PNGs (built here, not placeholders), so the
 * download and packet paths exercise actual images.
 */
import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createDb, migrate } from '../src/db.js';
import { bootstrap, createProject, createInvite, redeemInvite,
         requestLoginLink } from '../src/auth.js';
import { FsStorage } from '../src/storage.js';
import { runBugTranslations, runEventTranslations, StubProvider } from '../src/translate.js';
import { runOutbox, RecordingSender } from '../src/notify.js';
import { crc32 } from '../src/zip.js';

const BASE = process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const STORAGE_ROOT = process.env.STORAGE_DIR ?? './.rgm/storage';

/** Build a real, solid-colour PNG of the given size. */
function makePng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const db = await createDb({ dataDir: process.env.PGLITE_DIR });
await migrate(db);
const storage = new FsStorage({ root: STORAGE_ROOT, secret: 'seed-secret' });

// ── people ──
const admin = await bootstrap(db, 'yuen@rgm.example');
const project = await createProject(db, {
  name: 'Packing List Automation', client: 'Lucky Brand', env: 'staging',
  createdBy: admin.userId
});

const deliverSink = [];
for (const [email, role] of [['linh@rgm.example', 'tester'], ['wei@rgm.example', 'developer']]) {
  let inviteToken;
  await createInvite(db, {
    projectId: project.id, email, role, createdBy: admin.userId,
    deliver: (m) => { inviteToken = m.token; }
  });
  await redeemInvite(db, inviteToken);
}

// ── milestones ──
const ms = (await db.query(
  `INSERT INTO milestones (project_id, code, title_en, title_vi, title_zh, status, ready_count)
   VALUES ($1,'M3','Carton count validation','Kiểm tra số lượng thùng','紙箱數量驗證','ready',1)
   RETURNING id`, [project.id])).rows[0].id;
await db.query(
  `INSERT INTO milestones (project_id, code, title_en, title_vi, title_zh, status, due_at)
   VALUES ($1,'M4','Label printing','In nhãn','標籤列印','planned', now() + interval '21 days')`,
  [project.id]);

// ── bugs ──
const testerId = (await db.query(
  `SELECT id FROM users WHERE email = 'linh@rgm.example'`)).rows[0].id;

async function fileBug({ severity, titleVi, bodyVi, shots = [] }) {
  const number = (await db.query(
    `UPDATE project_counters SET next_bug_number = next_bug_number + 1
      WHERE project_id = $1 RETURNING next_bug_number - 1 AS n`, [project.id])).rows[0].n;
  const bug = (await db.query(
    `INSERT INTO bugs (project_id, milestone_id, bug_number, reporter_id, severity, title_vi, body_vi)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [project.id, ms, number, testerId, severity, titleVi, bodyVi])).rows[0].id;

  for (const lang of ['zh', 'en']) {
    for (const field of ['title', 'body']) {
      await db.query(
        `INSERT INTO bug_translations (bug_id, field, lang, status) VALUES ($1,$2,$3,'pending')`,
        [bug, field, lang]);
    }
  }
  await db.query(
    `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
     VALUES ($1,$2,$3,'bug.filed',$4)`,
    [project.id, bug, testerId, JSON.stringify({ severity })]);

  for (const { name, bytes } of shots) {
    const key = storage.keyFor(project.id, bug);
    await storage.put(key, bytes);
    const att = (await db.query(
      `INSERT INTO bug_attachments (project_id, bug_id, storage_key, filename, byte_size, content_type)
       VALUES ($1,$2,$3,$4,$5,'image/png') RETURNING id`,
      [project.id, bug, key, name, bytes.length])).rows[0].id;
    await db.query(
      `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
       VALUES ($1,$2,$3,'bug.attachment_added',$4)`,
      [project.id, bug, testerId, JSON.stringify({ attachmentId: att, filename: name })]);
  }
  return bug;
}

const bug1 = await fileBug({
  severity: 'high',
  titleVi: 'Số lượng thùng không khớp với bảng đóng gói',
  bodyVi: 'Thùng thứ 3 chỉ có 47 cái, bảng đóng gói ghi 50 cái. Đã đếm lại 2 lần vẫn thiếu 3 cái. Ảnh chụp màn hình đính kèm.',
  shots: [
    { name: 'thùng 3.png', bytes: makePng(240, 160, [220, 90, 90]) },
    { name: 'bảng đóng gói.png', bytes: makePng(240, 160, [90, 130, 220]) }
  ]
});
const bug2 = await fileBug({
  severity: 'medium',
  titleVi: 'Nhãn in bị lệch sang phải 3mm',
  bodyVi: 'Máy in nhãn in lệch sang phải khoảng 3mm khiến mã vạch không quét được.'
});

// ── lifecycle: dev fixes #1, requests retest, tester reports it still fails ──
const devId = (await db.query(
  `SELECT id FROM users WHERE email = 'wei@rgm.example'`)).rows[0].id;

await db.query(`UPDATE bugs SET status='fixing' WHERE id=$1`, [bug1]);
await db.query(
  `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
   VALUES ($1,$2,$3,'bug.fixing',$4)`,
  [project.id, bug1, devId, JSON.stringify({ action: 'start_fixing', from: 'new', to: 'fixing' })]);

await db.query(`UPDATE bugs SET status='retest', retest_attempt=1, retest_assignee_id=$2 WHERE id=$1`,
  [bug1, testerId]);
await db.query(
  `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
   VALUES ($1,$2,$3,'bug.retest',$4)`,
  [project.id, bug1, devId, JSON.stringify({ action: 'request_retest', from: 'fixing', to: 'retest' })]);

const failEvent = (await db.query(
  `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
   VALUES ($1,$2,$3,'bug.retest_fail',$4) RETURNING id`,
  [project.id, bug1, testerId,
    JSON.stringify({ result: 'fail', note: 'Đã kiểm tra lại, vẫn thiếu 3 cái ở thùng thứ 3',
                     attempt: 1, from: 'retest', to: 'fixing' })])).rows[0].id;
await db.query(`UPDATE bugs SET status='fixing', retest_assignee_id=NULL WHERE id=$1`, [bug1]);
for (const lang of ['zh', 'en']) {
  await db.query(
    `INSERT INTO event_translations (event_id, field, lang, status) VALUES ($1,'note',$2,'pending')`,
    [failEvent, lang]);
}

// ── a comment on bug 2, then run the workers ──
const commentEvent = (await db.query(
  `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
   VALUES ($1,$2,$3,'bug.commented',$4) RETURNING id`,
  [project.id, bug2, devId, JSON.stringify({ note: 'Tôi sẽ kiểm tra lại căn chỉnh máy in' })])).rows[0].id;
for (const lang of ['zh', 'en']) {
  await db.query(
    `INSERT INTO event_translations (event_id, field, lang, status) VALUES ($1,'note',$2,'pending')`,
    [commentEvent, lang]);
}

const workerId = randomUUID();
await runBugTranslations(db, StubProvider(), { workerId });
await runEventTranslations(db, StubProvider(), { workerId });

// ── notification for the ready milestone ──
await db.query(
  `INSERT INTO notifications_outbox (kind, project_id, subject_id, recipient_id, dedupe_key, payload)
   VALUES ('milestone.ready',$1,$2,$3,$4,$5)`,
  [project.id, ms, testerId, `milestone.ready:${ms}:gen1:${testerId}`,
    JSON.stringify({ milestoneCode: 'M3', generation: 1 })]);
const sender = RecordingSender();
await runOutbox(db, sender, { workerId });

// ── sign-in links ──
for (const email of ['linh@rgm.example', 'wei@rgm.example', 'yuen@rgm.example']) {
  await requestLoginLink(db, email, { deliver: (m) => {
    process.stdout.write(`\n  ${email}\n    ${BASE}/login?token=${m.token}\n`);
  }});
}

process.stdout.write(
  `\nseeded project "${project.name}" (${project.client})\n` +
  `  1 ready milestone, 2 bugs, ${sender.sent.length} notification delivered\n` +
  `  open one of the links above to sign in\n\n`);

if (db.close) await db.close();
