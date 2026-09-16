/**
 * Seed a disposable instance for the help-page screenshots.
 *
 *   HELP_DATA_DIR=/tmp/rgm-help node scripts/seed-help.mjs
 *
 * The help pages show the UI as a tester and as a developer see it, with real
 * data — never production data, so this seeds its own database and storage
 * under HELP_DATA_DIR. One bug per lifecycle state, so every chip colour is on
 * screen; Vietnamese report text plus zh/en translations, so the translated
 * panels are populated too.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { createDb, migrate } from '../src/db.js';
import { bootstrap, createProject, createInvite, redeemInvite } from '../src/auth.js';
import { FsStorage } from '../src/storage.js';
import { crc32 } from '../src/zip.js';

const DATA = process.env.HELP_DATA_DIR ?? '/tmp/rgm-help';
mkdirSync(`${DATA}/pg`, { recursive: true });
mkdirSync(`${DATA}/storage`, { recursive: true });
const db = await createDb({ dataDir: `${DATA}/pg` });
await migrate(db);
const storage = new FsStorage({ root: `${DATA}/storage`, secret: 'help-seed-secret' });

const admin = await bootstrap(db, 'yuen@rgm.example');
const project = await createProject(db, {
  name: 'Packing List Automation', client: 'Lucky Brand', env: 'staging',
  createdBy: admin.userId
});

for (const [email, role] of [['linh@rgm.example', 'tester'], ['wei@rgm.example', 'developer']]) {
  let token;
  await createInvite(db, {
    projectId: project.id, email, role,
    actor: { userId: admin.userId, isSiteAdmin: true },
    deliver: (m) => { token = m.token; }
  });
  await redeemInvite(db, token);
}

const testerId = (await db.query(
  `SELECT id FROM users WHERE email = 'linh@rgm.example'`)).rows[0].id;
const devId = (await db.query(
  `SELECT id FROM users WHERE email = 'wei@rgm.example'`)).rows[0].id;

const msReady = (await db.query(
  `INSERT INTO milestones (project_id, code, title_en, title_vi, title_zh, status, ready_count)
   VALUES ($1,'M3','Carton count validation','Kiểm tra số lượng thùng','紙箱數量驗證','ready',1)
   RETURNING id`, [project.id])).rows[0].id;
await db.query(
  `INSERT INTO milestones (project_id, code, title_en, title_vi, title_zh, status)
   VALUES ($1,'M4','Label printing','In nhãn','標籤列印','in_progress')`, [project.id]);

/** A real solid-colour PNG, as in seed-demo. */
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
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

async function fileBug({ titleVi, bodyVi, severity = 'medium', shots = [], tr = {} }) {
  const number = (await db.query(
    `UPDATE project_counters SET next_bug_number = next_bug_number + 1
      WHERE project_id = $1 RETURNING next_bug_number - 1 AS n`, [project.id])).rows[0].n;
  const bug = (await db.query(
    `INSERT INTO bugs (project_id, milestone_id, bug_number, reporter_id, severity, title_vi, body_vi)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [project.id, msReady, number, testerId, severity, titleVi, bodyVi])).rows[0].id;
  // Real translated text, inserted as already-done: the help pages must not show
  // a translation provider's stub output.
  for (const [lang, texts] of Object.entries(tr)) {
    for (const [field, text] of Object.entries(texts)) {
      await db.query(
        `INSERT INTO bug_translations (bug_id, field, lang, status, text, provider, model)
         VALUES ($1,$2,$3,'done',$4,'help-seed','help-seed')`,
        [bug, field, lang, text]);
    }
  }
  await db.query(
    `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
     VALUES ($1,$2,$3,'bug.filed',$4)`,
    [project.id, bug, testerId, JSON.stringify({ severity })]);
  for (const [i, colour] of shots.entries()) {
    const bytes = makePng(640, 400, colour);
    const key = storage.keyFor(project.id, bug);
    await storage.put(key, bytes);
    await db.query(
      `INSERT INTO bug_attachments (project_id, bug_id, storage_key, filename, byte_size, content_type)
       VALUES ($1,$2,$3,$4,$5,'image/png')`,
      [project.id, bug, key, `man-hinh-${i + 1}.png`, bytes.length]);
    await db.query(
      `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
       VALUES ($1,$2,$3,'bug.attachment_added',$4)`,
      [project.id, bug, testerId, JSON.stringify({ filename: `man-hinh-${i + 1}.png` })]);
  }
  return bug;
}

async function event(bugId, actorId, kind, payload) {
  await db.query(
    `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [project.id, bugId, actorId, kind, JSON.stringify(payload)]);
}

// ── one bug per lifecycle state, so every chip colour is on screen ──
const openBug = await fileBug({
  titleVi: 'Số lượng thùng trên phiếu đóng gói sai',
  bodyVi: 'Khi quét mã vạch thùng cuối, tổng số thùng hiển thị thiếu 1 so với thực tế. Xảy ra ở kho Bình Dương.',
  severity: 'high', shots: [[214, 69, 69]],
  tr: {
    zh: { title: '裝箱單上的紙箱數量錯誤',
          body: '掃描最後一箱時，顯示的總箱數比實際少 1 箱。發生於平陽倉。' },
    en: { title: 'Carton count on the packing list is wrong',
          body: 'Scanning the last carton shows one carton fewer than reality. Happens at the Binh Duong warehouse.' }
  }
});

const fixingBug = await fileBug({
  titleVi: 'Nhãn in bị lệch lề trái',
  bodyVi: 'Nhãn thùng in lệch khoảng 5mm, máy quét không đọc được mã.',
  tr: {
    zh: { title: '標籤列印左邊距偏移', body: '紙箱標籤向左偏移約 5mm，掃描器無法讀取條碼。' },
    en: { title: 'Printed label is offset to the left', body: 'Carton labels print about 5mm off; the scanner cannot read the code.' }
  }
});
await db.query(`UPDATE bugs SET status='fixing' WHERE id=$1`, [fixingBug]);
await event(fixingBug, devId, 'bug.fixing', { action: 'start_fixing', from: 'new', to: 'fixing' });

const retestBug = await fileBug({
  titleVi: 'Không tải được ảnh chụp màn hình',
  bodyVi: 'Bấm vào ảnh trong chi tiết lỗi thì trang trắng, phải tải về mới xem được.',
  shots: [[69, 132, 94]],
  tr: {
    zh: { title: '無法載入螢幕截圖', body: '在錯誤詳情中點按圖片會顯示空白頁，必須下載後才能檢視。' },
    en: { title: 'Screenshots will not load', body: 'Clicking an image in the bug detail shows a blank page; it only works after downloading.' }
  }
});
await db.query(`UPDATE bugs SET status='fixing' WHERE id=$1`, [retestBug]);
await event(retestBug, devId, 'bug.fixing', { action: 'start_fixing', from: 'new', to: 'fixing' });
await db.query(
  `UPDATE bugs SET status='retest', retest_attempt=1, retest_assignee_id=$2 WHERE id=$1`,
  [retestBug, devId]);
await event(retestBug, devId, 'bug.retest', { action: 'request_retest', from: 'fixing', to: 'retest' });

const closedBug = await fileBug({
  titleVi: 'Thiếu bản dịch tiếng Trung ở màn hình cột mốc',
  bodyVi: 'Đổi ngôn ngữ sang tiếng Trung nhưng tên cột mốc vẫn hiện tiếng Việt.',
  severity: 'low',
  tr: {
    zh: { title: '里程碑畫面缺少中文翻譯', body: '切換為中文後，里程碑名稱仍顯示越南文。' },
    en: { title: 'Missing Chinese translation on the milestone screen', body: 'After switching to Chinese, milestone names still show in Vietnamese.' }
  }
});
await db.query(`UPDATE bugs SET status='fixing' WHERE id=$1`, [closedBug]);
await event(closedBug, devId, 'bug.fixing', { action: 'start_fixing', from: 'new', to: 'fixing' });
await db.query(
  `UPDATE bugs SET status='retest', retest_attempt=1, retest_assignee_id=$2 WHERE id=$1`,
  [closedBug, testerId]);
await event(closedBug, devId, 'bug.retest', { action: 'request_retest', from: 'fixing', to: 'retest' });
const passEvent = (await db.query(
  `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
   VALUES ($1,$2,$3,'bug.retest_pass',$4) RETURNING id`,
  [project.id, closedBug, testerId,
    JSON.stringify({ result: 'pass', note: 'Đã kiểm tra lại, bản dịch hiện đúng.',
                     attempt: 1, from: 'retest', to: 'closed' })])).rows[0].id;
await db.query(`UPDATE bugs SET status='closed', retest_assignee_id=NULL WHERE id=$1`, [closedBug]);
await db.query(
  `INSERT INTO event_translations (event_id, field, lang, status, text, provider, model)
   VALUES ($1,'note','zh','done','已複檢，翻譯顯示正確。','help-seed','help-seed'),
          ($1,'note','en','done','Re-checked; the translation now displays correctly.','help-seed','help-seed')`,
  [passEvent]);

// A comment with a translation, so the timeline shows both languages.
const commentEvent = (await db.query(
  `INSERT INTO events (project_id, bug_id, actor_id, kind, payload)
   VALUES ($1,$2,$3,'bug.commented',$4) RETURNING id`,
  [project.id, retestBug, devId,
    JSON.stringify({ note: 'Tôi sẽ kiểm tra lại căn chỉnh máy in' })])).rows[0].id;
await db.query(
  `INSERT INTO event_translations (event_id, field, lang, status, text, provider, model)
   VALUES ($1,'note','zh','done','我會再檢查一次印表機的對齊設定。','help-seed','help-seed'),
          ($1,'note','en','done','I will check the printer alignment again.','help-seed','help-seed')`,
  [commentEvent]);

console.log(JSON.stringify({
  dataDir: DATA,
  accounts: { admin: 'yuen@rgm.example', tester: 'linh@rgm.example', dev: 'wei@rgm.example' },
  bugs: { open: openBug, fixing: fixingBug, retest: retestBug, closed: closedBug }
}, null, 2));
