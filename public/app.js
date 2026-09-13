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
    stNew: 'Mới', stFixing: 'Đang sửa', stRetest: 'Chờ test lại', stClosed: 'Đã đóng',
    noBugs: 'Chưa có lỗi nào cho dự án này 🎉', loading: 'Đang tải…',
    copyT: 'Bản prompt cho AI agent', copyP: 'Nội dung này do máy chủ tạo (GET /api/bugs/:id/prompt) — không phải bản sao trong trình duyệt.',
    copyBtn: '📋 Sao chép', copied: 'Đã sao chép — dán vào AI agent', copyFail: 'Không sao chép được — hãy chọn và copy thủ công',
    cliT: 'Lấy tất cả vào repo', dlAll: '⬇ Tải gói packet', dlFile: '⬇ Tải',
    dlHint: 'Gói packet dùng tên do máy chủ đặt (screenshot_01.png…) nên giải nén không thể ghi ra ngoài thư mục đích.',
    sevL: 'Mức độ', titleL: 'Tiêu đề (Tiếng Việt)', bodyL: 'Mô tả chi tiết',
    attachL: 'Ảnh chụp màn hình', submit: 'Gửi', cancel: 'Huỷ',
    actions: 'Hành động', reasonL: 'Lý do', noteL: 'Ghi chú', retest: 'Test lại',
    pass: 'Đạt', fail: 'Không đạt', assignee: 'Người test', anyTester: 'Bất kỳ tester nào',
    saved: 'Đã lưu', signOut: 'Đăng xuất', addNote: 'Thêm bình luận',
    noReady: 'Không có cột mốc nào ở trạng thái "Sẵn sàng kiểm thử".',
    trPending: 'Đang dịch…', trFailed: 'Dịch lỗi', trMissing: 'Chưa có bản dịch',
    noProjects: 'Chưa có dự án nào — hãy tạo dự án đầu tiên.', create: 'Tạo dự án',
    nameL: 'Tên dự án', envL: 'Môi trường'
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
    stNew: '新回報', stFixing: '修復中', stRetest: '待回歸測試', stClosed: '已關閉',
    noBugs: '這個專案目前沒有 bug 🎉', loading: '載入中…',
    copyT: '給 AI agent 的 prompt', copyP: '這段內容由伺服器產生(GET /api/bugs/:id/prompt),不是瀏覽器端的複製品。',
    copyBtn: '📋 複製', copied: '已複製 — 貼進 AI agent 即可', copyFail: '複製失敗 — 請手動選取複製',
    cliT: '取回 repo', dlAll: '⬇ 下載 packet', dlFile: '⬇ 下載',
    dlHint: 'packet 內使用伺服器指派的名稱(screenshot_01.png…),解壓縮不會寫出目標資料夾。',
    sevL: '嚴重程度', titleL: '標題(越南文)', bodyL: '詳細描述',
    attachL: '螢幕截圖', submit: '送出', cancel: '取消',
    actions: '可執行動作', reasonL: '原因', noteL: '備註', retest: '回歸測試',
    pass: '通過', fail: '不通過', assignee: '測試人員', anyTester: '任何測試人員',
    saved: '已儲存', signOut: '登出', addNote: '新增留言',
    noReady: '目前沒有「待測試」的里程碑。',
    trPending: '翻譯中…', trFailed: '翻譯失敗', trMissing: '尚無譯文',
    noProjects: '尚無專案——先建立第一個專案。', create: '建立專案',
    nameL: '專案名稱', envL: '環境'
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
    stNew: 'New', stFixing: 'Fixing', stRetest: 'Awaiting retest', stClosed: 'Closed',
    noBugs: 'No bugs in this project yet 🎉', loading: 'Loading…',
    copyT: 'Prompt for the AI agent', copyP: 'This text is produced by the server (GET /api/bugs/:id/prompt) — not a browser-side copy.',
    copyBtn: '📋 Copy', copied: 'Copied — paste into your AI agent', copyFail: 'Copy failed — select and copy manually',
    cliT: 'Pull into your repo', dlAll: '⬇ Download packet', dlFile: '⬇ Get',
    dlHint: 'The packet uses server-assigned names (screenshot_01.png…), so extraction cannot write outside the target folder.',
    sevL: 'Severity', titleL: 'Title (Vietnamese)', bodyL: 'Description',
    attachL: 'Screenshots', submit: 'Submit', cancel: 'Cancel',
    actions: 'Actions', reasonL: 'Reason', noteL: 'Note', retest: 'Retest',
    pass: 'Pass', fail: 'Fail', assignee: 'Assignee', anyTester: 'Any tester',
    saved: 'Saved', signOut: 'Sign out', addNote: 'Add comment',
    noReady: 'No milestone is currently ready for testing.',
    trPending: 'Translating…', trFailed: 'Translation failed', trMissing: 'No translation yet',
    noProjects: 'No projects yet — create the first one.', create: 'Create project',
    nameL: 'Project name', envL: 'Environment'
  }
};

const SEV = { high: { vi: 'Cao', zh: '高', en: 'High' }, medium: { vi: 'Trung bình', zh: '中', en: 'Medium' }, low: { vi: 'Thấp', zh: '低', en: 'Low' } };
const SEV_CLASS = { high: 'high', medium: 'med', low: 'low' };
const MS_CLASS = { planned: 'plan', in_progress: 'wip', ready: 'ready', done: 'done' };
const BUG_CLASS = { new: 'plan', fixing: 'wip', retest: 'ready', closed: 'done' };

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
  milestones: [], bugs: [], busy: false, notice: null
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

function statusLabel(kind, status) {
  const map = {
    planned: 'plan', in_progress: 'wip', ready: 'ready', done: 'done',
    new: 'stNew', fixing: 'stFixing', retest: 'stRetest', closed: 'stClosed'
  };
  return t(map[status] ?? status);
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
  S.milestones = milestones;
}

async function loadBugs() {
  const { bugs } = await api('GET', `/api/projects/${S.projectId}/bugs`);
  S.bugs = bugs;
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

async function refresh() {
  try {
    if (S.view === 'milestones') await loadMilestones();
    else await loadBugs();
    await loadProjects();
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
      <div class="project">${esc(project?.name ?? '')} · ${esc(project?.client ?? '')}</div>
      <h2>${heading}</h2>
    </div>
    <div class="right">
      <span class="pill">${t('tester')} ⇄ ${t('dev')}</span>
      <span class="pill gray">${esc(roleLabel)}</span>
      <span class="who"><span class="av">${esc((S.me.email[0] ?? '?').toUpperCase())}</span>${esc(S.me.email)}</span>
    </div>
  </div>`;
}

function milestoneCards() {
  if (!S.milestones.length) {
    return `<div class="empty">${t('loading')}</div>`;
  }
  const ready = S.milestones.filter((m) => m.status === 'ready');
  const hint = myRole() === 'tester'
    ? `<div class="hint">${ready.length
        ? `✅ ${ready.map((m) => esc(m.code)).join(', ')} — ${t('ready')}. ${t('report')} →`
        : t('noReady')}</div>`
    : '';

  return hint + `<div class="grid">${S.milestones.map((m) => `
    <div class="card">
      <span class="st ${MS_CLASS[m.status]}">${statusLabel('milestone', m.status)}</span>
      <h3 style="margin-top:10px">${esc(titleFor(m))}</h3>
      <div class="meta">${esc(m.code)} · ${t('due')} ${esc(m.due_at ? fmt(m.due_at) : '—')}</div>
      <div class="stamps">
        <div><em>${t('createdL')}</em><b>${fmt(m.updated_at)}</b></div>
        ${m.completed_at ? `<div><em>${t('done')}</em><b>${fmt(m.completed_at)}</b></div>` : ''}
        <div><em>${t('updatedL')}</em><b>${fmt(m.updated_at)}</b> <span class="rel">${rel(m.updated_at)}</span></div>
      </div>
      ${m.status === 'ready' && myRole() === 'tester'
        ? `<div class="foot" style="margin-top:12px">
             <button class="btn pri" data-action="report" data-ms="${esc(m.id)}">🐞 ${t('report')}</button>
           </div>` : ''}
    </div>`).join('')}</div>`;
}

function bugRows() {
  if (!S.bugs.length) return `<div class="empty">${t('noBugs')}</div>`;
  return S.bugs.map((b) => {
    const tr = b.id === S.bug?.id ? null : null; // row shows the Vietnamese title; detail shows translations
    return `
    <div class="row" data-action="openbug" data-id="${esc(b.id)}">
      <span class="sev ${SEV_CLASS[b.severity]}">${esc(SEV[b.severity][S.lang])}</span>
      <div class="body">
        <div class="id">${esc(b.code)} · ${esc(b.milestone_code)}</div>
        <div class="ttl">${esc(b.title_vi)}</div>
        <div class="sub">${statusLabel('bug', b.status)} · ${esc(b.attachments)} 📷</div>
        <div class="tags">
          <span class="tag">${t('whenL')} ${fmt(b.updated_at)}</span>
          <span class="tag">${rel(b.updated_at)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
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
      <span class="st ${BUG_CLASS[b.status]}">${statusLabel('bug', b.status)}</span>
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
          ${esc(a.action.replace(/_/g, ' '))} → ${statusLabel('bug', a.to)}
        </button>`).join(' ') : `<div class="tag">—</div>`}

      ${['retest'].includes(b.status) ? `
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="retestnote" placeholder="${t('noteL')} (${S.lang === 'vi' ? 'Tiếng Việt' : '…'})"
                 style="flex:1;min-width:220px">
          <button class="btn pri" data-action="retest" data-id="${esc(b.id)}" data-result="pass">✅ ${t('pass')}</button>
          <button class="btn" data-action="retest" data-id="${esc(b.id)}" data-result="fail">❌ ${t('fail')}</button>
        </div>` : ''}

      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <input id="commentnote" placeholder="${t('addNote')}" style="flex:1">
        <button class="btn" data-action="comment" data-id="${esc(b.id)}">${t('addNote')}</button>
      </div>
    </div>
  </div>`;
}

function reportForm() {
  const ready = S.milestones.filter((m) => m.status === 'ready');
  return `
  <div class="wrap">
    <a href="#" class="btn sm" data-action="cancelreport">${t('cancel')}</a>
    <div class="card" style="margin-top:14px;max-width:640px">
      <h2 style="margin:0 0 14px;font-size:16px">🐞 ${t('send')}</h2>
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
            <label>${t('nameL')}</label>
            <input id="f-pname" placeholder="Packing List Automation">
            <label>${t('client')}</label>
            <input id="f-pclient" placeholder="Lucky Brand">
            <label>${t('envL')}</label>
            <select id="f-penv">
              <option value="staging" selected>staging</option>
              <option value="production">production</option>
            </select>
            <div style="margin-top:14px">
              <button class="btn" data-action="createproject">${t('create')}</button>
            </div>
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

  const body = S.bug ? bugDetail()
    : S.reporting ? reportForm()
    : S.view === 'milestones' ? milestoneCards()
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
        const client = document.getElementById('f-pclient').value.trim();
        const env = document.getElementById('f-penv').value;
        if (!name || !client) {
          notice('Enter a project name and a client.', 'bad');
          break;
        }
        try {
          await api('POST', '/api/projects', { name, client, env });
          S.notice = null;
          await boot();
        } catch (err) {
          console.error(err);
          notice(String(err.message || 'Could not create the project.'), 'bad');
        }
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
  const severity = document.getElementById('f-sev').value;
  const titleVi = document.getElementById('f-title').value.trim();
  const bodyVi = document.getElementById('f-body').value.trim();
  const files = [...document.getElementById('f-files').files];

  if (!titleVi || !bodyVi) throw new Error('Title and description are required');
  S.busy = true;

  try {
    const bug = await api('POST', `/api/projects/${S.projectId}/bugs`,
      { milestoneId, severity, titleVi, bodyVi });

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
