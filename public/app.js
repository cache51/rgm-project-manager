/**
 * The web UI.
 *
 * It is deliberately thin: every value shown comes from the API, the agent
 * handoff text is fetched from `GET /api/bugs/:id/prompt` and the packet from
 * `GET /api/bugs/:id/packet`. Nothing here re-implements the prompt builder or
 * the packet layout — that duplication in the mock was the largest drift risk in
 * the repo, and this is what removes it.
 *
 * Untrusted text (bug titles, bodies, notes, filenames) is HTML-escaped wherever
 * it is interpolated, so a hostile report cannot inject markup into the page.
 */

const TZ = 'Asia/Ho_Chi_Minh';

const T = {
  vi: {
    projects: 'Dự án', ms: 'Các cột mốc', bugs: 'Danh sách lỗi', nav: 'Điều hướng',
    lang: 'Ngôn ngữ', tester: 'Tester', dev: 'Developer', admin: 'Quản trị',
    ready: 'Sẵn sàng kiểm thử', done: 'Đã xong', wip: 'Đang làm', plan: 'Kế hoạch',
    due: 'Hạn', report: 'Báo lỗi', view: 'Xem', send: 'Gửi báo lỗi',
    titleDetail: 'Chi tiết lỗi', back: '← Quay lại danh sách lỗi',
    original: 'Mô tả gốc của tester (Tiếng Việt)', translated: 'Bản dịch cho developer',
    shots: 'Ảnh chụp màn hình', info: 'Thông tin', testerL: 'Tester', whenL: 'Báo cáo lúc',
    msL: 'Cột mốc', statusL: 'Trạng thái', client: 'Khách hàng', updatedL: 'Cập nhật lúc',
    createdL: 'Tạo lúc', timeline: 'Lịch sử hoạt động', openL: 'Đang mở',
    stNew: 'Mới báo', stFixing: 'Đang sửa', stRetest: 'Đã sửa — chờ xác nhận', stClosed: 'Đã đóng',
    stRetestFeature: 'Đã làm — chờ xác nhận',
    kindL: 'Loại', kindBug: 'Lỗi', kindFeature: 'Yêu cầu tính năng', requestFeature: 'Yêu cầu tính năng',
    actStartWorking: 'Bắt đầu làm', actMarkImplemented: 'Đã làm xong',
    featureVerified: 'Xác nhận tính năng', notDone: 'Chưa đạt — trả lại',
    actStartFixing: 'Bắt đầu sửa', actMarkFixed: 'Đã sửa xong', actVerified: 'Xác nhận đã sửa',
    actStillBroken: 'Vẫn còn lỗi — trả lại', actClose: 'Đóng', actReopen: 'Mở lại',
    noBugs: 'Chưa có lỗi nào cho dự án này 🎉', loading: 'Đang tải…',
    copyT: 'Bản prompt cho AI agent', copyP: 'Nội dung này do máy chủ tạo (GET /api/bugs/:id/prompt) — không phải bản sao trong trình duyệt.',
    copyBtn: '📋 Sao chép', copied: 'Đã sao chép — dán vào AI agent', copyFail: 'Không sao chép được — hãy chọn và copy thủ công',
    cliT: 'Lấy tất cả vào repo', dlAll: '⬇ Tải gói packet', dlFile: '⬇ Tải',
    dlHint: 'Gói packet dùng tên do máy chủ đặt (screenshot_01.png…) nên giải nén không thể ghi ra ngoài thư mục đích.',
    sevL: 'Mức độ', titleL: 'Tiêu đề', bodyL: 'Mô tả chi tiết',
    attachL: 'Ảnh chụp màn hình', submit: 'Gửi', cancel: 'Huỷ',
    actions: 'Hành động', reasonL: 'Lý do', noteL: 'Ghi chú', retest: 'Test lại',
    pass: 'Đạt', fail: 'Không đạt', assignee: 'Người test', anyTester: 'Bất kỳ tester nào',
    saved: 'Đã lưu', signOut: 'Đăng xuất', addNote: 'Thêm bình luận',
    noReady: 'Không có cột mốc nào ở trạng thái "Sẵn sàng kiểm thử".',
    trPending: 'Đang dịch…', trFailed: 'Dịch lỗi', trMissing: 'Chưa có bản dịch',
    noProjects: 'Chưa có dự án nào — hãy tạo dự án đầu tiên.', create: 'Tạo dự án',
    nameL: 'Tên dự án', envL: 'Môi trường',
    team: 'Nhóm', personL: 'Tên người', emailL: 'Email', roleL: 'Vai trò',
    invite: 'Thêm người vào dự án', invited: 'Đã thêm vào dự án', needNameEmail: 'Cần tên và email',
    members: 'Thành viên', you: 'bạn', needName: 'Cần tên dự án',
    noMilestones: 'Chưa có cột mốc nào — hãy tạo cột mốc đầu tiên.',
    msCodeL: 'Mã cột mốc', msTitleL: 'Tên cột mốc', addMs: 'Tạo cột mốc',
    needMs: 'Cần mã và tên cột mốc',
    edit: 'Sửa', remove: 'Xoá', restore: 'Khôi phục', save: 'Lưu',
    showRemoved: 'Hiện mục đã xoá', removedL: 'Đã xoá',
    renameProject: 'Đổi tên dự án', projectSettings: 'Cài đặt dự án',
    confirmRemoveProject: 'Xoá dự án này? Dữ liệu vẫn được giữ và có thể khôi phục.',
    confirmRemoveMilestone: 'Xoá cột mốc này? Các lỗi vẫn được giữ.',
    confirmRemoveBug: 'Xoá lỗi này? Bằng chứng vẫn được giữ và có thể khôi phục.',
    renamed: 'Đã đổi tên', removed: 'Đã xoá — có thể khôi phục', restored: 'Đã khôi phục',
    editBug: 'Sửa báo cáo này',
    editHint: 'Sửa phần tiếng Việt sẽ đưa bản dịch vào hàng đợi dịch lại.',
    needBugText: 'Cần cả tiêu đề và nội dung',
    confirmRemoveMember: 'Xoá người này khỏi dự án?'
  },
  zh: {
    projects: '專案', ms: '里程碑', bugs: 'Bug 列表', nav: '導覽', lang: '語言',
    tester: '測試人員', dev: '開發人員', admin: '管理員',
    ready: '待測試', done: '已完成', wip: '進行中', plan: '規劃中',
    due: '期限', report: '回報問題', view: '檢視', send: '送出',
    titleDetail: 'Bug 詳情', back: '← 返回 Bug 列表',
    original: '測試人員原文(越南文)', translated: '開發人員檢視譯文',
    shots: '螢幕截圖', info: '基本資訊', testerL: '測試人員', whenL: '回報時間',
    msL: '所屬里程碑', statusL: '狀態', client: '客戶', updatedL: '最後更新',
    createdL: '建立時間', timeline: '活動時間軸', openL: '未關閉',
    stNew: '新回報', stFixing: '修復中', stRetest: '已修復——待確認', stClosed: '已關閉',
    stRetestFeature: '已完成——待確認',
    kindL: '類型', kindBug: 'Bug', kindFeature: '功能需求', requestFeature: '提出功能需求',
    actStartWorking: '開始處理', actMarkImplemented: '已完成',
    featureVerified: '功能已確認', notDone: '未完成——退回',
    actStartFixing: '開始修復', actMarkFixed: '已修好', actVerified: '確認修復',
    actStillBroken: '仍有問題——退回', actClose: '關閉', actReopen: '重新開啟',
    noBugs: '這個專案目前沒有 bug 🎉', loading: '載入中…',
    copyT: '給 AI agent 的 prompt', copyP: '這段內容由伺服器產生(GET /api/bugs/:id/prompt),不是瀏覽器端的複製品。',
    copyBtn: '📋 複製', copied: '已複製 — 貼進 AI agent 即可', copyFail: '複製失敗 — 請手動選取複製',
    cliT: '取回 repo', dlAll: '⬇ 下載 packet', dlFile: '⬇ 下載',
    dlHint: 'packet 內使用伺服器指派的名稱(screenshot_01.png…),解壓縮不會寫出目標資料夾。',
    sevL: '嚴重程度', titleL: '標題', bodyL: '詳細描述',
    attachL: '螢幕截圖', submit: '送出', cancel: '取消',
    actions: '可執行動作', reasonL: '原因', noteL: '備註', retest: '回歸測試',
    pass: '通過', fail: '不通過', assignee: '測試人員', anyTester: '任何測試人員',
    saved: '已儲存', signOut: '登出', addNote: '新增留言',
    noReady: '目前沒有「待測試」的里程碑。',
    trPending: '翻譯中…', trFailed: '翻譯失敗', trMissing: '尚無譯文',
    noProjects: '尚無專案——先建立第一個專案。', create: '建立專案',
    nameL: '專案名稱', envL: '環境',
    team: '團隊', personL: '姓名', emailL: '電子郵件', roleL: '角色',
    invite: '新增成員', invited: '已加入專案', needNameEmail: '需要姓名和電子郵件',
    members: '成員', you: '你', needName: '需要專案名稱',
    noMilestones: '尚無里程碑——先建立第一個。',
    msCodeL: '里程碑代碼', msTitleL: '里程碑名稱', addMs: '建立里程碑',
    needMs: '需要代碼和名稱',
    edit: '編輯', remove: '刪除', restore: '還原', save: '儲存',
    showRemoved: '顯示已刪除', removedL: '已刪除',
    renameProject: '更改專案名稱', projectSettings: '專案設定',
    confirmRemoveProject: '刪除此專案？資料會保留，可以還原。',
    confirmRemoveMilestone: '刪除此里程碑？其錯誤報告會保留。',
    confirmRemoveBug: '刪除此錯誤報告？證據會保留，可以還原。',
    renamed: '名稱已更新', removed: '已刪除——可以還原', restored: '已還原',
    editBug: '編輯此報告',
    editHint: '修改越南文內容後，翻譯會重新排入佇列。',
    needBugText: '標題和內容都必須填寫',
    confirmRemoveMember: '將此人從專案移除？'
  },
  en: {
    projects: 'Projects', ms: 'Milestones', bugs: 'Bug reports', nav: 'Navigation',
    lang: 'Language', tester: 'Tester', dev: 'Developer', admin: 'Admin',
    ready: 'Ready for testing', done: 'Done', wip: 'In progress', plan: 'Planned',
    due: 'Due', report: 'Report bug', view: 'View', send: 'Submit',
    titleDetail: 'Bug detail', back: '← Back to bug list',
    original: "Tester's original (Vietnamese)", translated: 'Translation for developer',
    shots: 'Screenshots', info: 'Details', testerL: 'Tester', whenL: 'Reported',
    msL: 'Milestone', statusL: 'Status', client: 'Client', updatedL: 'Last updated',
    createdL: 'Created', timeline: 'Activity timeline', openL: 'open',
    stNew: 'Open', stFixing: 'Being fixed', stRetest: 'Fixed — awaiting verification', stClosed: 'Closed',
    stRetestFeature: 'Implemented — awaiting verification',
    kindL: 'Kind', kindBug: 'Bug', kindFeature: 'Feature request', requestFeature: 'Request feature',
    actStartWorking: 'Start working', actMarkImplemented: 'Mark as implemented',
    featureVerified: 'Feature verified', notDone: 'Not done — send back',
    actStartFixing: 'Start fixing', actMarkFixed: 'Mark as fixed', actVerified: 'Fix verified',
    actStillBroken: 'Still broken — send back', actClose: 'Close', actReopen: 'Reopen',
    noBugs: 'No bugs in this project yet 🎉', loading: 'Loading…',
    copyT: 'Prompt for the AI agent', copyP: 'This text is produced by the server (GET /api/bugs/:id/prompt) — not a browser-side copy.',
    copyBtn: '📋 Copy', copied: 'Copied — paste into your AI agent', copyFail: 'Copy failed — select and copy manually',
    cliT: 'Pull into your repo', dlAll: '⬇ Download packet', dlFile: '⬇ Get',
    dlHint: 'The packet uses server-assigned names (screenshot_01.png…), so extraction cannot write outside the target folder.',
    sevL: 'Severity', titleL: 'Title', bodyL: 'Description',
    attachL: 'Screenshots', submit: 'Submit', cancel: 'Cancel',
    actions: 'Actions', reasonL: 'Reason', noteL: 'Note', retest: 'Retest',
    pass: 'Pass', fail: 'Fail', assignee: 'Assignee', anyTester: 'Any tester',
    saved: 'Saved', signOut: 'Sign out', addNote: 'Add comment',
    noReady: 'No milestone is currently ready for testing.',
    trPending: 'Translating…', trFailed: 'Translation failed', trMissing: 'No translation yet',
    noProjects: 'No projects yet — create the first one.', create: 'Create project',
    nameL: 'Project name', envL: 'Environment',
    team: 'Team', personL: 'Name', emailL: 'Email', roleL: 'Role',
    invite: 'Add someone to the project', invited: 'Added to the project', needNameEmail: 'A name and an email are required',
    members: 'Members', you: 'you', needName: 'A project name is required',
    noMilestones: 'No milestones yet — create the first one.',
    msCodeL: 'Milestone code', msTitleL: 'Milestone name', addMs: 'Add milestone',
    needMs: 'A code and a name are required',
    edit: 'Edit', remove: 'Remove', restore: 'Restore', save: 'Save',
    showRemoved: 'Show removed', removedL: 'Removed',
    renameProject: 'Rename project', projectSettings: 'Project settings',
    confirmRemoveProject: 'Remove this project? The data is kept and can be restored.',
    confirmRemoveMilestone: 'Remove this milestone? Its bug reports are kept.',
    confirmRemoveBug: 'Remove this bug? The evidence is kept and can be restored.',
    renamed: 'Name updated', removed: 'Removed — it can be restored', restored: 'Restored',
    editBug: 'Edit this report',
    editHint: 'Changing the Vietnamese text puts its translation back in the queue.',
    needBugText: 'A title and a description are both required',
    confirmRemoveMember: 'Remove this person from the project?'
  }
};

const SEV = { high: { vi: 'Cao', zh: '高', en: 'High' }, medium: { vi: 'Trung bình', zh: '中', en: 'Medium' }, low: { vi: 'Thấp', zh: '低', en: 'Low' } };
const ROLES = ['admin', 'developer', 'tester'];
const SEV_CLASS = { high: 'high', medium: 'med', low: 'low' };
const MS_CLASS = { planned: 'plan', in_progress: 'wip', ready: 'ready', done: 'done' };
// A bug's state, in the colours the workflow is described in: red while the problem is
// still there (reported, being fixed, or sent back after a failed retest), light green
// once a developer says it is fixed and it is waiting to be checked, green when it is
// done. `new` and `fixing` share a colour on purpose — to a tester looking at the list
// they mean the same thing: not fixed yet.
const BUG_CLASS = { new: 'open', fixing: 'open', retest: 'fixed', closed: 'verified' };

/**
 * What each move is called, in the words the workflow is described in.
 *
 * The state machine's action names are for the API (`request_retest`); a developer
 * reading a button should see "Mark as fixed".
 */
const BUG_ACTION_LABEL = {
  start_fixing: 'actStartFixing',
  request_retest: 'actMarkFixed',
  retest_pass: 'actVerified',
  retest_fail: 'actStillBroken',
  close: 'actClose',
  reopen: 'actReopen'
};

const LANGS = ['vi', 'zh', 'en'];

/**
 * Which language to open in: an explicit earlier choice, else the browser's, else
 * Vietnamese (the testers' language, and the one the reports are written in).
 *
 * Storage can throw — Safari private mode, or a user with site data blocked — so it
 * is wrapped rather than assumed.
 */
function initialLang() {
  try {
    const stored = localStorage.getItem('rgm.lang');
    if (LANGS.includes(stored)) return stored;
  } catch { /* no storage; fall back to the browser's preference */ }

  const fromBrowser = String(globalThis.navigator?.language ?? '').slice(0, 2).toLowerCase();
  return LANGS.includes(fromBrowser) ? fromBrowser : 'vi';
}

function rememberLang(lang) {
  try { localStorage.setItem('rgm.lang', lang); } catch { /* nothing to do about it */ }
}

const S = {
  me: null, projects: [], counts: {}, projectId: null,
  // Declared above this object on purpose: `initialLang` reads LANGS, and using it
  // here from further down the file throws a temporal-dead-zone error.
  view: 'milestones', lang: initialLang(), bug: null, prompt: null,
  milestones: null, bugs: null, busy: false, notice: null,
  members: [],
  // Screens that are revealed on demand: the create-project form is no longer only
  // the first-run screen, and the add-milestone form is no longer only the empty
  // list. Both were dead ends once you already had one of the thing.
  creatingProject: false, addingMilestone: false,
  // What the next report will be, chosen at the entry point and changeable on the form.
  reportKind: 'bug',
  // What has been removed from this project. Fetched alongside the live lists for the
  // roles that may put something back, so removal is reversible from the app rather
  // than only from SQL.
  removedMilestones: [], removedBugs: [], removedProjects: [],
  showRemoved: false, editing: false
};

// ───────────────────────── helpers ─────────────────────────

const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const t = (key) => T[S.lang]?.[key] ?? T.en[key] ?? key;
const langName = (lang) => ({ vi: 'Tiếng Việt', zh: '中文', en: 'English' }[lang]);

function fmt(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(iso));
}

function rel(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  const suffix = { vi: ['vừa xong', ' phút trước', ' giờ trước', ' ngày trước'],
                   zh: ['剛剛', ' 分鐘前', ' 小時前', ' 天前'],
                   en: ['just now', 'm ago', 'h ago', 'd ago'] }[S.lang];
  if (mins < 1) return suffix[0];
  if (mins < 60) return mins + suffix[1];
  if (mins < 1440) return Math.round(mins / 60) + suffix[2];
  return Math.round(mins / 1440) + suffix[3];
}

/** Read a non-HttpOnly cookie — the CSRF token lives here. */
function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function api(method, path, body) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };

  // Echo the CSRF cookie back in a header. A cross-site page can cause the
  // browser to send the session cookie, but it cannot read this value, so it
  // cannot forge the header.
  const csrf = readCookie('csrf');
  if (csrf) headers['x-csrf-token'] = csrf;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 401) { location.replace('/login'); throw new Error('signed out'); }
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new Error(payload?.message ?? `${res.status}`);
  return payload;
}

const myRole = () => S.me?.projects.find((p) => p.id === S.projectId)?.role ?? null;
const canDevelop = () => ['admin', 'developer'].includes(myRole());

function statusLabel(kind, status, reportKind = S.bug?.kind ?? S.reportKind) {
  // The states are the same for both kinds of report; the work is not. "Fixed" over a
  // request for something that never existed reads wrong.
  if (reportKind === 'feature' && status === 'retest') return t('stRetestFeature');
  const map = {
    planned: 'plan', in_progress: 'wip', ready: 'ready', done: 'done',
    new: 'stNew', fixing: 'stFixing', retest: 'stRetest', closed: 'stClosed'
  };
  return t(map[status] ?? status);
}

/**
 * What a move is called, for this kind of report.
 *
 * The actions are the same on the wire for both; only the words differ, so a feature
 * request never says "Mark as fixed".
 */
function moveLabel(action, reportKind = S.bug?.kind ?? S.reportKind) {
  const forFeature = {
    start_fixing: 'actStartWorking', request_retest: 'actMarkImplemented',
    retest_pass: 'featureVerified', retest_fail: 'notDone'
  }[action];
  const key = reportKind === 'feature' && forFeature ? forFeature : BUG_ACTION_LABEL[action];
  return t(key ?? action);
}

/** The project's own language for a milestone title, falling back sensibly. */
function titleFor(entity, field = 'title') {
  if (S.lang === 'zh' && entity[`${field}_zh`]) return entity[`${field}_zh`];
  if (S.lang === 'en' && entity[`${field}_en`]) return entity[`${field}_en`];
  if (S.lang === 'vi' && entity[`${field}_vi`]) return entity[`${field}_vi`];
  return entity[`${field}_en`] ?? entity[`${field}_vi`] ?? entity.title ?? '';
}

function notice(text, kind = 'ok') {
  S.notice = text ? { text, kind } : null;
  render();
  if (text) setTimeout(() => { S.notice = null; render(); }, 4000);
}

// ───────────────────────── data ─────────────────────────

async function loadProjects() {
  const { projects } = await api('GET', '/api/projects');
  S.projects = projects;
  if (!S.projectId && projects.length) S.projectId = projects[0].id;

  // Open-bug counts per project for the sidebar badges.
  const counts = await Promise.all(projects.map(async (p) => {
    try {
      const { openCount } = await api('GET', `/api/projects/${p.id}/bugs`);
      return [p.id, openCount];
    } catch { return [p.id, null]; }
  }));
  S.counts = Object.fromEntries(counts);
}

async function loadMilestones() {
  const { milestones } = await api('GET', `/api/projects/${S.projectId}/milestones`);
  // `?? []` rather than trusting the key to be there: an unexpected body used to leave
  // S.milestones undefined, and render() then threw on `.length` — a blank screen from
  // a payload shape, not from anything the user did.
  S.milestones = milestones ?? [];
}

async function loadBugs() {
  const { bugs } = await api('GET', `/api/projects/${S.projectId}/bugs`);
  S.bugs = bugs ?? [];
}

/**
 * Load what has been removed, for the roles that can put it back.
 *
 * A tester gets 403 from these routes, which is expected and must not surface as an
 * error notice — they simply never see the removed sections.
 */
async function loadRemoved() {
  S.removedMilestones = []; S.removedBugs = []; S.removedProjects = [];
  if (!['admin', 'developer'].includes(myRole())) return;

  try {
    if (S.view === 'milestones') {
      S.removedMilestones = (await api('GET',
        `/api/projects/${S.projectId}/milestones/removed`)).milestones ?? [];
    } else if (S.view === 'bugs') {
      S.removedBugs = (await api('GET',
        `/api/projects/${S.projectId}/bugs/removed`)).bugs ?? [];
    }
    if (myRole() === 'admin') {
      S.removedProjects = (await api('GET', '/api/projects/removed')).projects ?? [];
    }
  } catch (err) {
    // A failure to list removed rows must not break the screen that is working.
    console.error(err);
  }
}

async function openBug(id) {
  S.bug = await api('GET', `/api/bugs/${id}`);
  S.prompt = null;
  render();
  // Fetch the server-built prompt lazily so the detail view is not blocked by it.
  try {
    const res = await fetch(`/api/bugs/${id}/prompt`);
    S.prompt = res.ok ? await res.text() : null;
  } catch { S.prompt = null; }
  if (S.bug?.id === id) render();
}

async function loadMembers() {
  const { members } = await api('GET', `/api/projects/${S.projectId}/members`);
  S.members = members;
}

async function refresh() {
  try {
    if (S.view === 'milestones') await loadMilestones();
    else if (S.view === 'team') await loadMembers();
    else await loadBugs();
    await loadProjects();
    await loadRemoved();
    if (S.bug) S.bug = await api('GET', `/api/bugs/${S.bug.id}`);
    render();
  } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
}

// ───────────────────────── render ─────────────────────────

function sidebar() {
  const roleLabel = myRole() === 'admin' ? t('admin') : myRole() === 'developer' ? t('dev') : t('tester');
  return `
  <aside class="side">
    <div class="brand"><div class="mark">R</div>
      <div><b>RGM Project Manager</b><span>${esc(S.me.email)}</span></div></div>

    <div>
      <h4>${t('projects')}</h4>
      <div class="plist">
        ${S.projects.map((p) => `
          <div class="proj ${p.id === S.projectId ? 'on' : ''}" data-action="project" data-id="${esc(p.id)}">
            <span class="sq" style="background:${p.id === S.projectId ? '#fff' : '#6366f1'}"></span>
            <span class="nm">${esc(p.name)}</span>
            <span class="cnt ${S.counts[p.id] ? '' : 'zero'}">${S.counts[p.id] ?? ''}</span>
          </div>`).join('') || `<div class="hint" style="background:none;border:0;color:#64748b">${t('loading')}</div>`}
      </div>
    </div>

    ${S.me?.isSiteAdmin ? `
    <div class="padmin">
      <span class="mini" data-action="newproject">＋ ${t('create')}</span>
    </div>` : ''}

    ${myRole() === 'admin' && S.projectId ? `
    <div class="padmin">
      <span class="mini" data-action="renameproject">✎ ${t('renameProject')}</span>
      <span class="mini bad" data-action="removeproject">🗑 ${t('remove')}</span>
    </div>` : ''}

    ${myRole() === 'admin' && S.removedProjects.length ? `
    <div>
      <h4>${t('removedL')}</h4>
      <div class="plist">
        ${S.removedProjects.map((p) => `
          <div class="proj gone" title="${esc(p.name)}">
            <span class="nm">${esc(p.name)}</span>
            <span class="mini go" data-action="restoreproject" data-id="${esc(p.id)}">${t('restore')}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div>
      <h4>${t('nav')}</h4>
      <nav>
        <div class="nav ${S.view === 'milestones' && !S.bug ? 'on' : ''}" data-action="view" data-view="milestones">
          <span>🗂</span> ${t('ms')}
        </div>
        <div class="nav ${S.view === 'bugs' && !S.bug ? 'on' : ''}" data-action="view" data-view="bugs">
          <span>🐞</span> ${t('bugs')}
          <span class="badge">${S.counts[S.projectId] ?? 0}</span>
        </div>
        <div class="nav ${S.view === 'team' && !S.bug ? 'on' : ''}" data-action="view" data-view="team">
          <span>👤</span> ${t('team')}
        </div>
      </nav>
    </div>

    <div class="spacer"></div>
    <div class="langbox">
      <h4>${t('lang')}</h4>
      <div class="langrow">
        ${['vi', 'zh', 'en'].map((l) => `
          <div class="lang ${l === S.lang ? 'on' : ''}" data-action="lang" data-lang="${l}">${langName(l)}</div>`).join('')}
      </div>
      <div class="synced" style="margin-top:10px">
        <b>${t('signOut')}</b> · <a href="#" data-action="signout" style="color:#94a3b8">↩</a>
      </div>
    </div>
  </aside>`;
}

function topbar() {
  const project = S.projects.find((p) => p.id === S.projectId);
  const roleLabel = myRole() === 'admin' ? t('admin') : myRole() === 'developer' ? t('dev') : t('tester');
  const heading = S.bug ? t('titleDetail') : S.view === 'milestones' ? t('ms') : t('bugs');
  return `
  <div class="top">
    <div>
      <div class="project">${esc(project?.name ?? '')} · ${esc(project?.env ?? '')}</div>
      <h2>${heading}</h2>
    </div>
    <div class="right">
      <span class="pill">${t('tester')} ⇄ ${t('dev')}</span>
      <span class="pill gray">${esc(roleLabel)}</span>
      <span class="who"><span class="av">${esc((S.me.email[0] ?? '?').toUpperCase())}</span>${esc(S.me.email)}</span>
    </div>
  </div>`;
}

/**
 * The add-milestone form.
 *
 * Shared by the empty-list card and the "Add milestone" control above a populated
 * list — the form used to exist only in the empty case, so once a project had one
 * milestone there was no way to add a second.
 */
function addMilestoneForm() {
  return `
    <label>${t('msCodeL')}</label>
    <input id="f-mscode" placeholder="M1">
    <label>${t('msTitleL')}</label>
    <input id="f-mstitle" placeholder="Packing list import">
    <div style="margin-top:14px">
      <button class="btn" data-action="addmilestone">${t('addMs')}</button>
      ${S.milestones?.length ? `<button class="btn" data-action="canceladdms">${t('cancel')}</button>` : ''}
    </div>`;
}

function milestoneCards() {
  // `null` means not fetched yet; `[]` means fetched and genuinely empty. Showing
  // "Loading…" for the second case made a new project look permanently stuck.
  if (S.milestones === null) {
    return `<div class="empty">${t('loading')}</div>`;
  }

  if (!S.milestones.length) {
    return `
    <div class="card" style="max-width:560px">
      <h2 style="margin:0 0 12px;font-size:15px">🗂 ${t('addMs')}</h2>
      <p class="rel">${t('noMilestones')}</p>
      ${canDevelop() ? addMilestoneForm() : `<p class="rel">${t('noReady')}</p>`}
    </div>` + removedMilestones();
  }

  const ready = S.milestones.filter((m) => m.status === 'ready');
  const hint = myRole() === 'tester'
    ? `<div class="hint">${ready.length
        ? `✅ ${ready.map((m) => esc(m.code)).join(', ')} — ${t('ready')}. ${t('report')} →`
        : t('noReady')}</div>`
    : '';

  // A way to add another milestone, above the list. It used to be offered only when
  // the list was empty, so a project with one milestone could never get a second.
  const addControl = canDevelop()
    ? (S.addingMilestone
        ? `<div class="card" style="max-width:560px;margin-bottom:16px">
             <h2 style="margin:0 0 12px;font-size:15px">🗂 ${t('addMs')}</h2>
             ${addMilestoneForm()}
           </div>`
        : `<div style="margin-bottom:14px">
             <span class="mini" data-action="showaddms">＋ ${t('addMs')}</span>
           </div>`)
    : '';

  return hint + addControl + `<div class="grid">${S.milestones.map((m) => `
    <div class="card">
      <span class="st ${MS_CLASS[m.status]}">${statusLabel('milestone', m.status)}</span>
      <h3 style="margin-top:10px">${esc(titleFor(m))}</h3>
      <div class="meta">${esc(m.code)} · ${t('due')} ${esc(m.due_at ? fmt(m.due_at) : '—')}</div>
      <div class="stamps">
        <div><em>${t('createdL')}</em><b>${fmt(m.updated_at)}</b></div>
        ${m.completed_at ? `<div><em>${t('done')}</em><b>${fmt(m.completed_at)}</b></div>` : ''}
        <div><em>${t('updatedL')}</em><b>${fmt(m.updated_at)}</b> <span class="rel">${rel(m.updated_at)}</span></div>
      </div>
      <!-- The moves come from the server (availableActions), so the buttons offered
           are exactly the ones the route will accept. -->
      ${(m.availableActions ?? []).length ? `
        <div class="foot" style="margin-top:12px;gap:8px;flex-wrap:wrap">
          ${m.availableActions.map((a) => `
            <button class="btn sm" data-action="mstransition" data-id="${esc(m.id)}"
                    data-move="${esc(a.action)}" data-reason="${a.requiresReason ? '1' : ''}">
              ${esc(a.action)} → ${statusLabel('milestone', a.to)}
            </button>`).join(' ')}
        </div>` : ''}
      ${m.status === 'ready' ? `
        <div class="foot" style="margin-top:12px;gap:8px;flex-wrap:wrap">
          <button class="btn pri" data-action="report" data-ms="${esc(m.id)}" data-kind="bug">🐞 ${t('report')}</button>
          <button class="btn" data-action="report" data-ms="${esc(m.id)}" data-kind="feature">✨ ${t('requestFeature')}</button>
        </div>` : ''}
      ${canDevelop() ? `
        <div class="foot" style="margin-top:12px;gap:8px">
          <span class="mini" data-action="renamemilestone" data-id="${esc(m.id)}">✎ ${t('edit')}</span>
          <span class="mini bad" data-action="removemilestone" data-id="${esc(m.id)}">🗑 ${t('remove')}</span>
        </div>` : ''}
    </div>`).join('')}</div>` + removedMilestones();
}

/**
 * Milestones that were removed, with a way back.
 *
 * Removal hides a milestone from the list, so without this the only route back would
 * be hand-written SQL — which is not a thing a developer should have to do.
 */
function removedMilestones() {
  if (!canDevelop() || !S.removedMilestones.length) return '';
  return `
  <div class="removed-group">
    <h4 style="font-size:12px;color:#64748b;margin:0 0 8px">${t('removedL')}</h4>
    ${S.removedMilestones.map((m) => `
      <div class="card removed" style="margin-bottom:8px">
        <div class="meta">${esc(m.code)} · ${esc(titleFor(m))}</div>
        <div class="foot" style="margin-top:10px">
          <span class="mini go" data-action="restoremilestone" data-id="${esc(m.id)}">↩ ${t('restore')}</span>
        </div>
      </div>`).join('')}
  </div>`;
}

/**
 * The team: who is on this project, and a way to add someone with a name.
 *
 * The name is given at invitation time, which is when the inviter knows who the
 * person is — otherwise every user is named after their email local part, and a
 * project with several testers from one company shows "test01", "qa.linh" and so on.
 * That is what made "who reported this?" unanswerable without opening every report.
 */
function teamPanel() {
  const isAdmin = myRole() === 'admin';
  const ROLE_KEY = { tester: 'tester', developer: 'dev', admin: 'admin' };

  return `
  <div class="wrap">
    ${isAdmin ? `
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin:0 0 12px;font-size:15px">👤 ${t('invite')}</h2>
      <label>${t('personL')}</label>
      <input id="f-mname" placeholder="Nguyễn Văn A">
      <label>${t('emailL')}</label>
      <input id="f-memail" placeholder="a@rgm.example">
      <label>${t('roleL')}</label>
      <select id="f-mrole">
        <option value="tester" selected>${t('tester')}</option>
        <option value="developer">${t('dev')}</option>
        <option value="admin">${t('admin')}</option>
      </select>
      <div style="margin-top:14px">
        <button class="btn" data-action="invite">${t('invite')}</button>
      </div>
    </div>` : ''}

    <h2 style="font-size:15px;margin:0 0 10px">${t('members')} (${S.members.length})</h2>
    ${S.members.map((m) => `
      <div class="row" style="cursor:default">
        <span class="sev low">${esc(t(ROLE_KEY[m.role] ?? m.role))}</span>
        <div class="body">
          <div class="id">${esc(m.display_name)}${m.id === S.me?.userId ? ` · ${t('you')}` : ''}</div>
          <div class="sub rel">${esc(m.email)}</div>
          ${isAdmin ? `
          <div class="foot" style="margin-top:8px;gap:6px;flex-wrap:wrap">
            ${ROLES.map((r) => r === m.role ? '' : `
              <span class="mini" data-action="setrole" data-id="${esc(m.id)}"
                    data-role="${r}">${t('roleL')}: ${esc(t(ROLE_KEY[r] ?? r))}</span>`).join('')}
            <span class="mini bad" data-action="removemember" data-id="${esc(m.id)}">🗑 ${t('remove')}</span>
          </div>` : ''}
        </div>
      </div>`).join('')}
  </div>`;
}

function bugRows() {
  if (S.bugs === null) return `<div class="empty">${t('loading')}</div>`;
  if (!S.bugs.length) return `<div class="empty">${t('noBugs')}</div>` + removedBugs();
  const rows = S.bugs.map((b) => `
    <div class="row" data-action="openbug" data-id="${esc(b.id)}">
      <span class="sev ${SEV_CLASS[b.severity]}">${esc(SEV[b.severity][S.lang])}</span>
      <div class="body">
        <div class="id">${esc(b.code)} · ${esc(b.milestone_code)}</div>
        <div class="ttl">${b.kind === 'feature' ? '✨' : '🐞'} ${esc(b.title_vi)}</div>
        <div class="sub">${esc(b.reporter)} · ${esc(b.attachments)} 📷</div>
        <div class="tags">
          <span class="tag">${t('whenL')} ${fmt(b.updated_at)}</span>
          <span class="tag">${rel(b.updated_at)}</span>
        </div>
      </div>
      <!-- The state, in its colour, so a tester scanning the list can see at a glance
           which ones are waiting to be verified. -->
      <span class="st ${BUG_CLASS[b.status]}">${statusLabel('bug', b.status)}</span>
    </div>`).join('');
  return rows + removedBugs();
}

/** Bugs that were removed, with a way back. Removal must not be a one-way door. */
function removedBugs() {
  if (!canDevelop() || !S.removedBugs.length) return '';
  return `
  <div class="removed-group">
    <h4 style="font-size:12px;color:#64748b;margin:0 0 8px">${t('removedL')}</h4>
    ${S.removedBugs.map((b) => `
      <div class="row removed" style="cursor:default">
        <span class="sev ${SEV_CLASS[b.severity]}">${esc(SEV[b.severity][S.lang])}</span>
        <div class="body">
          <div class="id">${esc(b.code)} · ${esc(b.reporter)}</div>
          <div class="ttl">${esc(b.title_vi)}</div>
          <div class="foot" style="margin-top:8px">
            <span class="mini go" data-action="restorebug" data-id="${esc(b.id)}">↩ ${t('restore')}</span>
          </div>
        </div>
      </div>`).join('')}
  </div>`;
}

function translationBlock(field) {
  if (S.lang === 'vi') return '';
  const t9n = S.bug.translations?.[field]?.[S.lang];
  if (!t9n) return `<div class="tag">${t('trMissing')}</div>`;
  if (t9n.status === 'done') return `<pre class="pre">${esc(t9n.text)}</pre>`;
  if (t9n.status === 'failed') {
    return `<div class="tag" style="background:var(--high-bg);color:var(--high)">
      ${t('trFailed')}: ${esc(t9n.error ?? '')}</div>`;
  }
  return `<div class="tag">${t('trPending')}</div>`;
}

function timelineBlock() {
  if (!S.bug.timeline?.length) return '';
  return `<h3 style="margin:22px 0 10px;font-size:14px">${t('timeline')}</h3>
    <div class="card" style="padding:8px 14px">
      ${S.bug.timeline.map((e) => {
        const note = e.note ?? e.reason;
        const tr = note ? e.noteTranslations?.[S.lang] : null;
        return `
        <div class="tl">
          <div class="tl-h">
            <b>${esc(e.actor)}</b> · <span class="tag">${esc(e.kind.replace(/^bug\./, ''))}</span>
            <span class="rel" style="margin-left:auto">${fmt(e.at)} · ${rel(e.at)}</span>
          </div>
          ${note ? `<div class="tl-n">${esc(note)}</div>` : ''}
          ${tr?.status === 'done' ? `<div class="tl-t">↳ ${esc(tr.text)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
}

function bugDetail() {
  const b = S.bug;
  const shots = b.attachments ?? [];
  return `
  <div class="wrap">
    <a href="#" class="btn sm" data-action="closebug">${t('back')}</a>

    <div class="card" style="margin-top:14px">
      <span class="sev ${SEV_CLASS[b.severity]}">${esc(SEV[b.severity][S.lang])}</span>
      <span class="st ${BUG_CLASS[b.status]}">${statusLabel('bug', b.status, b.kind)}</span>
      ${b.kind === 'feature' ? `<span class="st verified">✨ ${t('kindFeature')}</span>` : ''}
      <h2 style="margin:10px 0 4px;font-size:17px">${esc(b.code)} — ${esc(b.titleVi)}</h2>
      <div class="meta">${esc(b.projectId ? '' : '')}${t('testerL')}: ${esc(b.reporter.name)} ·
        ${t('msL')}: ${esc(b.milestone.code)} · ${t('whenL')} ${fmt(b.createdAt)}</div>
      <div class="stamps">
        <div><em>${t('createdL')}</em><b>${fmt(b.createdAt)}</b></div>
        <div><em>${t('updatedL')}</em><b>${fmt(b.updatedAt)}</b> <span class="rel">${rel(b.updatedAt)}</span></div>
        <div><em>${t('statusL')}</em><b>${esc(b.status)}</b></div>
        ${b.retestAttempt ? `<div><em>retest</em><b>#${b.retestAttempt}</b></div>` : ''}
      </div>
    </div>

    ${S.editing ? editForm() : ''}

    <div class="grid2">
      <div class="card">
        <h3 style="font-size:13px;color:var(--muted)">${t('original')}</h3>
        <pre class="pre">${esc(b.bodyVi)}</pre>
        ${translationBlock('body') ? `<h3 style="font-size:13px;color:var(--muted);margin-top:14px">${t('translated')} (${langName(S.lang)})</h3>` : ''}
        ${translationBlock('body')}
      </div>
      <div class="card">
        <h3 style="font-size:13px;color:var(--muted)">${t('shots')} (${shots.length})</h3>
        ${shots.length ? shots.map((a) => `
          <div class="att">
            <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>
            <span class="rel">${esc(a.originalFilename)} · ${(a.byteSize / 1024).toFixed(1)} KB</span>
            <a class="btn sm" href="${esc(a.url)}" download="${esc(a.name)}">${t('dlFile')}</a>
          </div>`).join('') : `<div class="tag">—</div>`}
        <div class="hint" style="margin-top:12px">${t('dlHint')}</div>
        <a class="btn pri" href="#" data-action="packet" data-id="${esc(b.id)}">${t('dlAll')}</a>
      </div>
    </div>

    ${S.prompt ? `
      <h3 style="margin:22px 0 10px;font-size:14px">${t('copyT')}</h3>
      <div class="card">
        <div class="hint" style="margin:0 0 10px">${t('copyP')}</div>
        <pre class="pre scroll" id="prompttext">${esc(S.prompt)}</pre>
        <button class="btn pri" style="margin-top:10px" data-action="copy">${t('copyBtn')}</button>
      </div>` : ''}

    ${timelineBlock()}

    <h3 style="margin:22px 0 10px;font-size:14px">${t('actions')}</h3>
    <div class="card">
      ${(b.availableActions ?? []).length ? b.availableActions.map((a) => `
        <button class="btn" data-action="transition" data-id="${esc(b.id)}"
                data-move="${esc(a.action)}" data-reason="${a.requiresReason ? '1' : ''}">
          ${esc(moveLabel(a.action))} → ${statusLabel('bug', a.to, b.kind)}
        </button>`).join(' ') : `<div class="tag">—</div>`}

      ${['retest'].includes(b.status) ? `
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="retestnote" placeholder="${t('noteL')} (${S.lang === 'vi' ? 'Tiếng Việt' : '…'})"
                 style="flex:1;min-width:220px">
          <button class="btn pri" data-action="retest" data-id="${esc(b.id)}" data-result="pass">✅ ${esc(moveLabel('retest_pass', b.kind))}</button>
          <button class="btn" data-action="retest" data-id="${esc(b.id)}" data-result="fail">❌ ${esc(moveLabel('retest_fail', b.kind))}</button>
        </div>` : ''}

      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <input id="commentnote" placeholder="${t('addNote')}" style="flex:1">
        <button class="btn" data-action="comment" data-id="${esc(b.id)}">${t('addNote')}</button>
      </div>

      ${canEditBug() || myRole() === 'admin' ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line,#e2e8f0);display:flex;gap:8px;flex-wrap:wrap">
        ${canEditBug()
          ? `<span class="mini" data-action="editbug">✎ ${t('editBug')}</span>` : ''}
        ${myRole() === 'admin'
          ? `<span class="mini bad" data-action="removebug" data-id="${esc(b.id)}">🗑 ${t('remove')}</span>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}

/** Who may correct a report: whoever filed it, or an admin, and only while it is open. */
function canEditBug() {
  const b = S.bug;
  if (!b || b.status === 'closed') return false;
  return myRole() === 'admin' || b.reporter?.id === S.me?.userId;
}

/**
 * The inline editor for a report.
 *
 * The Vietnamese is what gets translated, so the note says what saving will do: the
 * translation for whichever field changed is regenerated, and the developers stop
 * reading a translation of the sentence that was just corrected.
 */
function editForm() {
  const b = S.bug;
  return `
  <div class="card" style="margin-top:14px">
    <h3 style="margin:0 0 4px;font-size:14px">✎ ${t('editBug')}</h3>
    <p class="rel" style="margin:0 0 8px">${t('editHint')}</p>
    <div class="editform">
      <label for="f-etitle">${t('titleL')}</label>
      <textarea id="f-etitle" rows="2">${esc(b.titleVi)}</textarea>
      <label for="f-ebody">${t('bodyL')}</label>
      <textarea id="f-ebody" rows="6">${esc(b.bodyVi)}</textarea>
      <label for="f-eseverity">${t('sevL')}</label>
      <select id="f-eseverity">
        ${['high', 'medium', 'low'].map((s) =>
          `<option value="${s}"${s === b.severity ? ' selected' : ''}>${esc(SEV[s][S.lang])}</option>`).join('')}
      </select>
    </div>
    <div class="foot" style="gap:8px">
      <button class="btn pri" data-action="savebug" data-id="${esc(b.id)}">${t('save')}</button>
      <button class="btn" data-action="canceledit">${t('cancel')}</button>
    </div>
  </div>`;
}

function reportForm() {
  const ready = (S.milestones ?? []).filter((m) => m.status === 'ready');
  return `
  <div class="wrap">
    <a href="#" class="btn sm" data-action="cancelreport">${t('cancel')}</a>
    <div class="card" style="margin-top:14px;max-width:640px">
      <h2 style="margin:0 0 14px;font-size:16px">🐞 ${t('send')}</h2>
      <label>${t('kindL')}</label>
      <select id="f-kind">
        <option value="bug"${S.reportKind === 'feature' ? '' : ' selected'}>🐞 ${t('kindBug')}</option>
        <option value="feature"${S.reportKind === 'feature' ? ' selected' : ''}>✨ ${t('kindFeature')}</option>
      </select>
      <label>${t('msL')}</label>
      <select id="f-ms">${ready.map((m) => `<option value="${esc(m.id)}"${m.id === S.reportFor ? ' selected' : ''}>${esc(m.code)} — ${esc(titleFor(m))}</option>`).join('')}</select>
      <label>${t('sevL')}</label>
      <select id="f-sev">
        <option value="high">${esc(SEV.high[S.lang])}</option>
        <option value="medium" selected>${esc(SEV.medium[S.lang])}</option>
        <option value="low">${esc(SEV.low[S.lang])}</option>
      </select>
      <label>${t('titleL')}</label>
      <input id="f-title" placeholder="Số lượng thùng không khớp">
      <label>${t('bodyL')}</label>
      <textarea id="f-body" rows="5" placeholder="Thùng thứ 3 chỉ có 47 cái, bảng đóng gói ghi 50 cái."></textarea>
      <label>${t('attachL')}</label>
      <input id="f-files" type="file" accept="image/*" multiple>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn pri" data-action="submitreport" data-ms="${esc(S.reportFor)}">${t('send')}</button>
        <button class="btn" data-action="cancelreport">${t('cancel')}</button>
      </div>
    </div>
  </div>`;
}

/**
 * The create-project form.
 *
 * Shared by the first-run screen and the sidebar's "New project", so the two cannot
 * drift — and so that having one project does not remove the ability to add another.
 * (It did: this form lived only inside the first-run screen, which renders only when
 * you have no projects at all.)
 */
function createProjectForm() {
  return `
    <label>${t('nameL')}</label>
    <input id="f-pname" placeholder="Packing List Automation">
    <label>${t('envL')}</label>
    <select id="f-penv">
      <option value="staging" selected>staging</option>
      <option value="production">production</option>
    </select>
    <div style="margin-top:14px">
      <button class="btn" data-action="createproject">${t('create')}</button>
      ${S.creatingProject ? `<button class="btn" data-action="cancelproject">${t('cancel')}</button>` : ''}
    </div>`;
}

/**
 * The screen a signed-in user sees before any project exists.
 *
 * A site admin gets a working create form: the API has always allowed
 * POST /api/projects for them, but the screen offered no way to do it, so a fresh
 * install was a dead end whose own sentence promised a capability it did not
 * provide. Everyone else is told what to wait for.
 */
function firstRun() {
  const me = S.me;
  return `
      <main style="margin:auto;padding:60px">
        ${S.notice ? `<div class="toast ${S.notice.kind}">${esc(S.notice.text)}</div>` : ''}
        <div class="card" style="max-width:520px;margin:auto">
          <h2 style="margin-top:0">${t('projects')}</h2>
          ${me.isSiteAdmin ? `
            <p class="rel">${t('noProjects')}</p>
            ${createProjectForm()}
          ` : `
            <p>${esc(me.email)} is not a member of any project yet.</p>
            <p class="rel">An admin must invite you.</p>
          `}
          <div style="margin-top:16px">
            <button class="btn" data-action="signout">${t('signOut')}</button>
          </div>
          <!-- The switcher belongs here too: this screen renders before any sidebar,
               so without it a first-run operator cannot change the language at all. -->
          <div class="langbox" style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">
            <h4>${t('lang')}</h4>
            <div class="langrow">
              ${LANGS.map((l) => `<div class="lang ${l === S.lang ? 'on' : ''}" data-action="lang" data-lang="${l}">${langName(l)}</div>`).join('')}
            </div>
          </div>
        </div>
      </main>`;
}

function render() {
  const app = document.getElementById('app');

  // A signed-in user with no project gets the first-run screen — through here, not
  // painted once by boot(). Otherwise any later render (changing the language, say)
  // replaced it with a shell containing no project, losing the create form.
  if (!S.me?.projects.length) {
    app.innerHTML = firstRun();
    return;
  }

  const body = S.creatingProject ? `
    <div class="card" style="max-width:560px">
      <h2 style="margin:0 0 12px;font-size:15px">＋ ${t('create')}</h2>
      ${createProjectForm()}
    </div>`
    : S.bug ? bugDetail()
    : S.reporting ? reportForm()
    : S.view === 'milestones' ? milestoneCards()
    : S.view === 'team' ? teamPanel()
    : bugRows();

  app.innerHTML = sidebar() + `
    <main>
      ${topbar()}
      ${S.notice ? `<div class="toast ${S.notice.kind}">${esc(S.notice.text)}</div>` : ''}
      <div class="wrap">${body}</div>
    </main>`;
}

// ───────────────────────── actions ─────────────────────────

document.getElementById('app').addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  event.preventDefault();
  if (S.busy) return;

  try {
    switch (action) {
      // ── revealing the forms that used to be unreachable ──
      case 'newproject':
        S.creatingProject = true;
        render();
        break;
      case 'cancelproject':
        S.creatingProject = false;
        render();
        break;
      case 'showaddms':
        S.addingMilestone = true;
        render();
        break;
      case 'canceladdms':
        S.addingMilestone = false;
        render();
        break;
      case 'mstransition': {
        // `reset` needs a reason, and the server records it. A prompt answered with
        // nothing means the move was abandoned, so nothing is sent.
        const needsReason = el.dataset.reason === '1';
        const reason = needsReason ? (window.prompt(t('reasonL')) ?? '').trim() : undefined;
        if (needsReason && !reason) break;
        try {
          await api('POST', `/api/milestones/${el.dataset.id}/status`,
            { action: el.dataset.move, reason });
          notice(t('saved'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      // ── editing and removing ──
      // Each of these does the thing and then reloads, so what is on screen is what
      // the server now holds rather than what was hoped for.
      case 'renameproject': {
        const name = (window.prompt(t('renameProject')) ?? '').trim();
        if (!name) break;
        try {
          await api('PATCH', `/api/projects/${S.projectId}`, { name });
          notice(t('renamed'));
          await boot();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'removeproject': {
        if (!window.confirm(t('confirmRemoveProject'))) break;
        try {
          await api('DELETE', `/api/projects/${S.projectId}`);
          S.projectId = null; S.bug = null;
          notice(t('removed'));
          await boot();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'restoreproject': {
        try {
          await api('POST', `/api/projects/${el.dataset.id}/restore`, {});
          notice(t('restored'));
          await boot();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'renamemilestone': {
        const current = S.milestones.find((m) => m.id === el.dataset.id);
        const titleEn = (window.prompt(t('msTitleL'), current?.title_en ?? '') ?? '').trim();
        if (!titleEn) break;
        try {
          await api('PATCH', `/api/milestones/${el.dataset.id}`, { titleEn });
          notice(t('renamed'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'removemilestone': {
        if (!window.confirm(t('confirmRemoveMilestone'))) break;
        try {
          await api('DELETE', `/api/milestones/${el.dataset.id}`);
          notice(t('removed'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'restoremilestone': {
        try {
          await api('POST', `/api/milestones/${el.dataset.id}/restore`, {});
          notice(t('restored'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'editbug':
        S.editing = true;
        render();
        break;
      case 'canceledit':
        S.editing = false;
        render();
        break;
      case 'savebug': {
        const titleVi = document.getElementById('f-etitle').value.trim();
        const bodyVi = document.getElementById('f-ebody').value.trim();
        const severity = document.getElementById('f-eseverity').value;
        if (!titleVi || !bodyVi) {
          notice(t('needBugText'), 'bad');
          break;
        }
        try {
          await api('PATCH', `/api/bugs/${el.dataset.id}`, { titleVi, bodyVi, severity });
          S.editing = false;
          notice(t('saved'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'removebug': {
        if (!window.confirm(t('confirmRemoveBug'))) break;
        try {
          await api('DELETE', `/api/bugs/${el.dataset.id}`);
          S.bug = null; S.editing = false;
          notice(t('removed'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'restorebug': {
        try {
          await api('POST', `/api/bugs/${el.dataset.id}/restore`, {});
          notice(t('restored'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'setrole': {
        try {
          await api('PATCH', `/api/projects/${S.projectId}/members/${el.dataset.id}`,
            { role: el.dataset.role });
          notice(t('saved'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'removemember': {
        if (!window.confirm(t('confirmRemoveMember'))) break;
        try {
          await api('DELETE', `/api/projects/${S.projectId}/members/${el.dataset.id}`);
          notice(t('removed'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'project':
        S.projectId = el.dataset.id; S.bug = null; S.prompt = null;
        await refresh();
        break;
      case 'view':
        S.view = el.dataset.view; S.bug = null; S.reporting = false;
        await refresh();
        break;
      case 'lang':
        S.lang = el.dataset.lang;
        rememberLang(S.lang);
        render();
        break;
      case 'signout':
        await api('POST', '/api/auth/logout');
        location.replace('/login');
        break;
      case 'createproject': {
        // The first thing a new install needs. Failures are surfaced rather than
        // swallowed, because there is nothing else on this screen to try.
        const name = document.getElementById('f-pname').value.trim();
        const env = document.getElementById('f-penv').value;
        if (!name) {
          notice(t('needName'), 'bad');
          break;
        }
        try {
          const created = await api('POST', '/api/projects', { name, env });
          S.notice = null;
          S.creatingProject = false;
          // Adding a second project: stay where you are and switch to it, rather than
          // dropping the operator back into whatever they were looking at.
          if (S.me?.projects.length && created?.id) S.projectId = created.id;
          await boot();
        } catch (err) {
          console.error(err);
          notice(String(err.message || 'Could not create the project.'), 'bad');
        }
        break;
      }
      case 'addmilestone': {
        const code = document.getElementById('f-mscode').value.trim();
        const titleEn = document.getElementById('f-mstitle').value.trim();
        if (!code || !titleEn) {
          notice(t('needMs'), 'bad');
          break;
        }
        try {
          await api('POST', `/api/projects/${S.projectId}/milestones`, { code, titleEn });
          S.addingMilestone = false;
          notice(t('saved'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'invite': {
        const name = document.getElementById('f-mname').value.trim();
        const email = document.getElementById('f-memail').value.trim();
        const role = document.getElementById('f-mrole').value;
        if (!name || !email) {
          notice(t('needNameEmail'), 'bad');
          break;
        }
        try {
          // Applied immediately: no invite token to deliver and no mailer to deliver
          // it with. The person can sign in with this address straight away.
          await api('POST', `/api/projects/${S.projectId}/members`, { name, email, role });
          notice(t('invited'));
          await refresh();
        } catch (err) { console.error(err); notice(String(err.message), 'bad'); }
        break;
      }
      case 'openbug':
        await openBug(el.dataset.id);
        break;
      case 'closebug':
        S.bug = null; S.prompt = null; await refresh();
        break;
      case 'report':
      case 'cancelreport':
        S.bug = null; S.reporting = action === 'report';
        S.reportFor = action === 'report' ? el.dataset.ms : null;
        // The button you pressed decides; the form lets you change your mind.
        S.reportKind = action === 'report' ? (el.dataset.kind ?? 'bug') : 'bug';
        if (action === 'report') await loadMilestones();
        render();
        break;
      case 'submitreport':
        await submitReport();
        break;
      case 'transition':
        await transition(el.dataset.id, el.dataset.move, el.dataset.reason === '1');
        break;
      case 'retest':
        await retest(el.dataset.id, el.dataset.result);
        break;
      case 'comment':
        await comment(el.dataset.id);
        break;
      case 'copy':
        await copyPrompt();
        break;
      case 'packet':
        await downloadPacket(el.dataset.id);
        break;
    }
  } catch (err) {
    // Logged as well as shown: a notice vanishes after four seconds, and a silently
    // swallowed error is the hardest kind to diagnose — including in tests.
    console.error(err);
    notice(String(err.message), 'bad');
  }
});

async function submitReport() {
  const milestoneId = document.getElementById('f-ms').value;
  const kind = document.getElementById('f-kind')?.value ?? 'bug';
  const severity = document.getElementById('f-sev').value;
  const titleVi = document.getElementById('f-title').value.trim();
  const bodyVi = document.getElementById('f-body').value.trim();
  const files = [...document.getElementById('f-files').files];

  if (!titleVi || !bodyVi) throw new Error('Title and description are required');
  S.busy = true;

  try {
    const bug = await api('POST', `/api/projects/${S.projectId}/bugs`,
      { milestoneId, severity, titleVi, bodyVi, kind });

    // Two-phase upload: presign, PUT the bytes, then complete. The server chooses
    // the key and, for the proxying driver, hands back a signed upload URL; for a
    // bucket-backed deployment it hands back a presigned URL straight to storage.
    for (const file of files) {
      const signed = await api('POST', `/api/bugs/${bug.id}/attachments/presign`,
        { contentType: file.type || 'image/png', byteSize: file.size });

      const put = await fetch(signed.uploadUrl, {
        method: 'PUT',
        body: file,
        // The signed headers must be sent verbatim, or the signature will not match.
        headers: signed.uploadHeaders ?? { 'content-type': file.type || 'image/png' }
      });
      if (!put.ok) throw new Error(`upload failed for ${file.name}`);

      await api('POST', `/api/bugs/${bug.id}/attachments/complete`, {
        storageKey: signed.storageKey,
        uploadToken: signed.uploadToken ?? undefined,
        filename: file.name,
        contentType: file.type || 'image/png'
      });
    }

    S.reporting = false;
    S.view = 'bugs';
    notice(`${bug.code} ${t('saved')} · ${files.length} 📷`);
    await refresh();
  } finally { S.busy = false; }
}

async function transition(id, action, needsReason) {
  let reason;
  if (needsReason) {
    reason = prompt(`${t('reasonL')} (${action.replace(/_/g, ' ')}):`);
    if (!reason) return;
  }
  S.busy = true;
  try {
    await api('POST', `/api/bugs/${id}/status`, { action, reason });
    notice(t('saved'));
    await openBug(id);
    await loadProjects();
  } finally { S.busy = false; }
}

async function retest(id, result) {
  const note = document.getElementById('retestnote')?.value.trim() || undefined;
  S.busy = true;
  try {
    // expectedAttempt carries the caller's view so a stale tab cannot close a
    // newer cycle — the server rejects the mismatch.
    await api('POST', `/api/bugs/${id}/retest`,
      { result, note, expectedAttempt: S.bug.retestAttempt });
    notice(t('saved'));
    await openBug(id);
    await loadProjects();
  } finally { S.busy = false; }
}

async function comment(id) {
  const note = document.getElementById('commentnote')?.value.trim();
  if (!note) return;
  S.busy = true;
  try {
    await api('POST', `/api/bugs/${id}/comments`, { note });
    notice(t('saved'));
    await openBug(id);
  } finally { S.busy = false; }
}

async function copyPrompt() {
  const text = S.prompt ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    notice(t('copied'));
  } catch {
    // Clipboard access can be denied (insecure origin, permissions). Say so
    // rather than claiming a copy that did not happen.
    const pre = document.getElementById('prompttext');
    if (pre) {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
    notice(t('copyFail'), 'bad');
  }
}

async function downloadPacket(id) {
  const res = await fetch(`/api/bugs/${id}/packet`);
  if (!res.ok) throw new Error(`packet download failed (${res.status})`);
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'packet.zip';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  notice(`${name} (${(blob.size / 1024).toFixed(0)} KB)`);
}

// ───────────────────────── boot ─────────────────────────

async function boot() {
  let me;
  try {
    me = await api('GET', '/api/me');
  } catch { return; } // api() already redirected to /login
  if (!me) { location.replace('/login'); return; }

  S.me = me;
  // No longer forced to Vietnamese when there are no projects: the language an
  // operator chose (or their browser's) is what they get. Forcing it meant the only
  // language switcher — in the sidebar — was hidden on the very screen that was
  // stuck in a language they could not read.

  if (!me.projects.length) {
    // One definition of this screen, in firstRun(). It used to live here as well, and
    // a second copy is a copy that can drift — this one had already lost the language
    // switcher and the create form's neighbours.
    render();
    return;
  }

  await loadProjects();
  await refresh();
}

boot();
