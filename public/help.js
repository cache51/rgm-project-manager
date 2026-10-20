/**
 * Help pages (vi / zh-Hant / en), illustrated with screenshots of the real UI.
 *
 * The screenshots are shot against a seeded disposable instance by
 * scripts/shoot-help.mjs and live in public/help/. Each language shows its own
 * screenshots, so a Vietnamese reader never sees a Chinese screen. English —
 * the reading language of the agents, not of the shop floor — carries the same
 * sections in text until its own screenshots are shot.
 */
const img = (lang, name, cap) =>
  `<figure><img src="/help/${lang}-${name}.png" alt="${cap}"><figcaption>${cap}</figcaption></figure>`;

const CHIPS = (open, fixed, verified) => `
  <div class="chips">
    <span class="chip open">${open}</span>
    <span class="chip fixed">${fixed}</span>
    <span class="chip verified">${verified}</span>
  </div>`;

const DOCS = {
  vi: {
    htmlLang: 'vi',
    title: 'Hướng dẫn — RGM Project Manager',
    h1: 'Hướng dẫn sử dụng',
    lead: 'Dành cho tester và developer: báo lỗi, sửa, xác nhận — và cách đọc trạng thái của một lỗi.',
    sections: [
      {
        h: '1. Đăng nhập',
        body: (L) => `
          <p>Nhập địa chỉ email mà quản trị đã thêm bạn vào dự án. <b>Không có mật khẩu</b> —
          vai trò của bạn (tester / developer / quản trị) đến từ chính địa chỉ đó.</p>
          ${img(L, 'login', 'Màn hình đăng nhập: chỉ một ô email')}
          <div class="note">Nếu thấy báo <i>“địa chỉ này chưa ở dự án nào”</i>, hãy nhờ quản trị
          thêm email của bạn vào dự án trước.</div>`
      },
      {
        h: '2. Ba màn hình chính',
        body: (L) => `
          <ul>
            <li><b>Các cột mốc</b> — tiến độ từng cột mốc của dự án; tester báo lỗi từ đây.</li>
            <li><b>Danh sách lỗi</b> — mọi lỗi và yêu cầu tính năng của dự án, kèm trạng thái.</li>
            <li><b>Nhóm</b> — ai đang ở trong dự án và vai trò của họ.</li>
          </ul>
          ${img(L, 'milestones', 'Màn hình cột mốc, với nút báo lỗi ở cột mốc sẵn sàng')}`
      },
      {
        h: '3. Tester báo lỗi',
        body: (L) => `
          <p>Ở màn hình cột mốc, bấm <b>🐞 Báo lỗi</b> trên cột mốc đang sẵn sàng kiểm thử.
          Một báo cáo gồm: loại (<b>lỗi</b> hoặc <b>yêu cầu tính năng</b>), cột mốc, mức độ,
          tiêu đề, mô tả chi tiết bằng tiếng Việt, và ảnh chụp màn hình nếu có.</p>
          ${img(L, 'reportform', 'Phiếu báo lỗi: loại, cột mốc, mức độ, tiêu đề, mô tả, ảnh chụp')}
          <p>Mô tả tiếng Việt được dịch tự động sang tiếng Trung và tiếng Anh cho developer;
          bản gốc luôn được giữ nguyên trong chi tiết lỗi.</p>`
      },
      {
        h: '4. Vòng đời của một lỗi',
        body: (L) => `
          <p>Màu của nhãn trạng thái nói lỗi đang ở đâu:</p>
          ${CHIPS('vẫn còn vấn đề', 'đã sửa — chờ xác nhận', 'đã xong')}
          <table>
            <tr><th>Bước</th><th>Ai</th><th>Làm gì</th><th>Kết quả</th></tr>
            <tr><td>1</td><td>Tester</td><td>Báo lỗi</td><td><b>Mới báo</b></td></tr>
            <tr><td>2</td><td>Developer</td><td>Bắt đầu sửa</td><td><b>Đang sửa</b></td></tr>
            <tr><td>3</td><td>Developer</td><td>Đã sửa xong</td><td><b>Đã sửa — chờ xác nhận</b></td></tr>
            <tr><td>4a</td><td>Tester</td><td>Xác nhận đã sửa</td><td><b>Đã đóng</b></td></tr>
            <tr><td>4b</td><td>Tester</td><td>Vẫn còn lỗi — trả lại (kèm ghi chú)</td><td><b>Đang sửa</b></td></tr>
          </table>
          ${img(L, 'buglist', 'Danh sách lỗi: bốn trạng thái, bốn màu nhãn')}
          <p>Developer đóng lỗi bằng một trong hai nút: <b>🔁 Trùng với báo cáo khác</b> —
          chọn báo cáo gốc trong danh sách, hoặc <b>🚫 Từ chối</b>. Cả hai đều cần lý do;
          quyết định được ghi vào chi tiết lỗi và lịch sử hoạt động.</p>
          ${img(L, 'closepanel', 'Bảng đóng lỗi: chọn lý do đóng và báo cáo gốc')}
          <p>Xác nhận là việc của tester: khi lỗi chờ xác nhận, tester (hoặc quản trị) thấy
          nút <b>Xác nhận đã sửa</b> và <b>Vẫn còn lỗi — trả lại</b>; ghi chú trả lại được dịch
          cho developer. Developer đã đánh dấu sửa xong thì không tự xác nhận được.</p>
          ${img(L, 'bugdetail', 'Chi tiết lỗi dưới mắt tester: nút xác nhận và ô bình luận')}
          <p>Ô bình luận nhận nhiều dòng; bấm Ctrl+Enter để gửi.</p>
          <p>Khi developer (hoặc AI agent) cần bạn làm rõ một lỗi bạn đã báo, lỗi đó được đưa
          lên đầu danh sách với nhãn <b>💬 Câu hỏi chờ bạn trả lời</b> — trạng thái của lỗi giữ
          nguyên. Thanh bên và màn hình cột mốc cho biết có bao nhiêu câu hỏi đang chờ bạn.
          Mở lỗi: câu hỏi nằm ngay trên cùng; trả lời ở đó, hoặc bằng một bình luận.</p>`
      },
      {
        h: '5. Ai nhận email khi sửa xong',
        body: (L) => `
          <p>Developer (hoặc quản trị) gắn một hay nhiều địa chỉ email vào từng lỗi, ở mục
          <b>Email báo khi sửa xong</b> trong chi tiết lỗi. Khi lỗi chuyển sang
          <b>Đã sửa — chờ xác nhận</b>, mỗi địa chỉ trong danh sách nhận một email kèm mã lỗi,
          tiêu đề và đường dẫn vào ứng dụng.</p>
          ${img(L, 'notify', 'Danh sách email nhận thông báo, trong chi tiết lỗi')}
          <p>Chỉ những địa chỉ trong danh sách được báo — thêm email của tester đã báo lỗi,
          kể cả người chưa là thành viên dự án. Bỏ một địa chỉ khỏi danh sách thì lần sửa sau
          họ không còn nhận email nữa.</p>`
      },
      {
        h: '6. Ảnh chụp màn hình và gói packet',
        body: (L) => `
          <p>Ảnh đính kèm hiện trong chi tiết lỗi và tải về từng cái được. Nút
          <b>⬇ Tải gói packet</b> lấy về một tệp ZIP gồm <code>bug.md</code> (bản prompt cho
          AI agent), toàn bộ ảnh chụp và siêu dữ liệu — để developer đưa thẳng vào repo.
          Tên tệp trong gói do máy chủ đặt, nên giải nén không thể ghi ra ngoài thư mục đích.</p>`
      },
      {
        h: '7. Ngôn ngữ',
        body: () => `
          <p>Đổi ngôn ngữ giao diện ở cuối thanh bên: <b>Tiếng Việt / 中文 / English</b>.
          Lựa chọn được nhớ cho lần sau. Nội dung báo cáo luôn giữ bản tiếng Việt gốc kèm
          bản dịch, bất kể ngôn ngữ giao diện.</p>`
      },
      {
        h: '8. Nhóm và vai trò',
        body: (L) => `
          <p>Quản trị thêm thành viên bằng email và gán vai trò:
          <b>tester</b> (báo lỗi, xác nhận), <b>developer</b> (sửa, đóng, mở lại),
          <b>quản trị</b> (thêm người, đổi vai trò, cột mốc).</p>
          ${img(L, 'team', 'Màn hình nhóm: thành viên và vai trò')}`
      }
    ]
  },

  zh: {
    htmlLang: 'zh-Hant',
    title: '使用說明 — RGM Project Manager',
    h1: '使用說明',
    lead: '給測試人員與開發人員：如何回報問題、修復、確認，以及如何解讀問題的狀態。',
    sections: [
      {
        h: '1. 登入',
        body: (L) => `
          <p>輸入管理員為您登記的電郵地址。<b>不需要密碼</b>——您的角色（測試人員／開發人員／管理員）
          就由這個地址決定。</p>
          ${img(L, 'login', '登入畫面：只有一個電郵欄位')}
          <div class="note">若看到 <i>「此電郵尚未加入任何專案」</i>，請先請管理員把您加入專案。</div>`
      },
      {
        h: '2. 三個主要畫面',
        body: (L) => `
          <ul>
            <li><b>里程碑</b>——專案各里程碑的進度；測試人員在此回報問題。</li>
            <li><b>Bug 列表</b>——專案所有問題與功能要求，附狀態。</li>
            <li><b>團隊</b>——專案成員及其角色。</li>
          </ul>
          ${img(L, 'milestones', '里程碑畫面，就緒的里程碑上有回報按鈕')}`
      },
      {
        h: '3. 測試人員回報問題',
        body: (L) => `
          <p>在里程碑畫面，按就緒里程碑上的 <b>🐞 回報</b> 按鈕。一筆回報包含：
          類型（<b>問題</b> 或 <b>功能要求</b>）、里程碑、嚴重度、標題、越南文詳細描述，
          以及螢幕截圖（如有）。</p>
          ${img(L, 'reportform', '回報表單：類型、里程碑、嚴重度、標題、描述、截圖')}
          <p>越南文描述會自動翻譯成中文與英文給開發人員；原文永遠保留在問題詳情中。</p>`
      },
      {
        h: '4. 問題的生命週期',
        body: (L) => `
          <p>狀態標籤的顏色代表問題走到哪一步：</p>
          ${CHIPS('仍有問題', '已修復——待確認', '已完成')}
          <table>
            <tr><th>步驟</th><th>誰</th><th>做什麼</th><th>結果</th></tr>
            <tr><td>1</td><td>測試人員</td><td>回報問題</td><td><b>新回報</b></td></tr>
            <tr><td>2</td><td>開發人員</td><td>開始修復</td><td><b>修復中</b></td></tr>
            <tr><td>3</td><td>開發人員</td><td>已修復</td><td><b>已修復——待確認</b></td></tr>
            <tr><td>4a</td><td>測試人員</td><td>確認已修復</td><td><b>已關閉</b></td></tr>
            <tr><td>4b</td><td>測試人員</td><td>仍有問題——退回（附註記）</td><td><b>修復中</b></td></tr>
          </table>
          ${img(L, 'buglist', 'Bug 列表：四種狀態、四種標籤顏色')}
          <p>開發人員以兩個按鈕之一關閉問題：<b>🔁 與其他回報重複</b>——從清單選擇原回報，
          或 <b>🚫 拒絕</b>。兩者都需要原因；決定會記錄在問題詳情與歷史中。</p>
          ${img(L, 'closepanel', '關閉面板：選擇關閉原因與原回報')}
          <p>確認是測試人員的工作：問題待確認時，測試人員（或管理員）會看到
          <b>確認已修復</b> 與 <b>仍有問題——退回</b> 兩個按鈕；退回註記會翻譯給開發人員。
          標記已修復的開發人員不能自己確認。</p>
          ${img(L, 'bugdetail', '測試人員視角的問題詳情：確認按鈕與留言欄')}
          <p>留言欄可輸入多行；按 Ctrl+Enter 送出。</p>
          <p>當開發人員（或 AI agent）需要您釐清您回報的內容時，該筆回報會排到列表最上方，並標示
          <b>💬 有提問待你回答</b>——回報的狀態不變。側欄與里程碑畫面也會顯示有幾個提問在等您回答。
          打開回報，提問就在最上方；在那裡回答，或直接留言即可。</p>`
      },
      {
        h: '5. 修復後誰會收到電郵',
        body: (L) => `
          <p>開發人員（或管理員）可在問題詳情的 <b>修復後通知的電郵</b> 區塊，為每個問題加入
          一個或多個電郵地址。問題轉為 <b>已修復——待確認</b> 時，名單上的每個地址都會收到一封
          電郵，內含問題編號、標題與應用程式連結。</p>
          ${img(L, 'notify', '問題詳情中的通知電郵名單')}
          <p>只有名單上的地址會收到通知——可加入回報問題的測試人員，即使他尚未加入專案。
          把地址從名單移除後，之後的修復就不再通知他。</p>`
      },
      {
        h: '6. 螢幕截圖與 packet 檔',
        body: () => `
          <p>附件顯示在問題詳情中，可逐一下載。<b>⬇ 下載 packet</b> 會取得一個 ZIP，內含
          <code>bug.md</code>（給 AI agent 的 prompt）、全部截圖與中繼資料——供開發人員直接放進
          repo。檔內名稱由伺服器指派，因此解壓縮不會寫到目標資料夾以外。</p>`
      },
      {
        h: '7. 語言',
        body: () => `
          <p>在側欄底部切換介面語言：<b>Tiếng Việt / 中文 / English</b>，選擇會被記住。
          無論介面語言為何，回報內容永遠保留越南原文與譯文。</p>`
      },
      {
        h: '8. 團隊與角色',
        body: (L) => `
          <p>管理員以電郵加入成員並指派角色：<b>測試人員</b>（回報、確認）、
          <b>開發人員</b>（修復、關閉、重開）、<b>管理員</b>（加人、改角色、里程碑）。</p>
          ${img(L, 'team', '團隊畫面：成員與角色')}`
      }
    ]
  },
  en: {
    htmlLang: 'en',
    title: 'Guide — RGM Project Manager',
    h1: 'How to use the board',
    lead: 'For testers and developers: file a bug, fix it, verify it — and how to read a report’s state.',
    sections: [
      {
        h: '1. Signing in',
        body: () => `
          <p>Type the email address an admin added to the project. <b>There are no passwords</b> —
          your role (tester / developer / admin) comes from that address.</p>
          <div class="note">If you see <i>“this address is not in any project”</i>, ask an admin to
          add you first.</div>`
      },
      {
        h: '2. The three screens',
        body: () => `
          <ul>
            <li><b>Milestones</b> — progress across the project; testers file reports from here.</li>
            <li><b>Bug list</b> — every report and feature request, with its state.</li>
            <li><b>Team</b> — who is in the project, and in what role.</li>
          </ul>`
      },
      {
        h: '3. Filing a report (tester)',
        body: () => `
          <p>On the milestones screen — or with the 🐞 button on the Bugs tab — start a report.
          It carries: kind (<b>bug</b> or <b>feature request</b>), milestone, severity, a title, a
          description in Vietnamese, and screenshots when you have them.</p>
          <p>The Vietnamese text is translated into Chinese and English for developers; the
          original is always kept on the report, and a failed translation can be retried from
          where it is shown.</p>`
      },
      {
        h: '4. The life of a bug',
        body: () => `
          <p>The state chip’s colour tells you where a report stands:</p>
          ${CHIPS('still broken', 'fixed — awaiting verification', 'done')}
          <table>
            <tr><th>Step</th><th>Who</th><th>What</th><th>Becomes</th></tr>
            <tr><td>1</td><td>Tester</td><td>files the bug</td><td><b>Reported</b></td></tr>
            <tr><td>2</td><td>Developer</td><td>starts fixing</td><td><b>Fixing</b></td></tr>
            <tr><td>3</td><td>Developer</td><td>marks it fixed — optionally naming the tester who should verify</td><td><b>Fixed — awaiting verification</b></td></tr>
            <tr><td>4a</td><td>Tester</td><td>confirms the fix</td><td><b>Closed</b></td></tr>
            <tr><td>4b</td><td>Tester</td><td>sends it back, with a note</td><td><b>Fixing</b></td></tr>
          </table>
          <p>A developer closes a report with one of two buttons: <b>🔁 Duplicate of another
          report</b> — picking the original from the list — or <b>🚫 Rejected</b>. Both want a
          reason, and the decision is kept in the report’s history.</p>
          <p>Verification is the tester’s call: while a report awaits verification, the assigned
          tester (or any tester, if nobody was named) sees <b>Confirm fixed</b> and
          <b>Still broken — send back</b>; the list marks which ones are yours. The developer who
          marked a fix cannot confirm it.</p>
          <p>The comment box takes several lines; Ctrl+Enter sends.</p>`
      },
      {
        h: '5. Who gets the email when a fix lands',
        body: () => `
          <p>A developer or admin can add one or more email addresses per bug, in the
          <b>Email to notify when fixed</b> block. When the report moves to
          <b>Fixed — awaiting verification</b>, every address on the list is emailed the report’s
          number, title and a link — and so is the tester who filed it.</p>
          <p>Removing an address stops its future notices; the filer always hears about their own
          bug.</p>`
      },
      {
        h: '6. Screenshots and the packet',
        body: () => `
          <p>Attachments are listed on the report and downloadable one by one.
          <b>⬇ Download packet</b> gives a ZIP with <code>bug.md</code> (the prompt for an AI
          agent), every screenshot and the metadata — built to drop into a developer’s repo. File
          names inside are assigned by the server, so unpacking cannot write outside the folder
          you chose.</p>`
      },
      {
        h: '7. Language',
        body: () => `
          <p>The sidebar’s bottom switches the interface: <b>Tiếng Việt / 中文 / English</b>, and
          the choice is remembered. Whatever the interface language, a report keeps its
          Vietnamese original beside its translations.</p>`
      },
      {
        h: '8. Team, roles and agents',
        body: () => `
          <p>An admin adds people by email and gives them a role: <b>tester</b> (files, verifies),
          <b>developer</b> (fixes, closes, reopens), <b>admin</b> (people, roles, milestones).</p>
          <p>The 🤖 Agent access screen mints API tokens for AI agents. A token sees only the
          scopes it was given — anyone on the team can mint a tester- or developer-level token;
          an admin-scope token needs an admin.</p>`
      }
    ]
  }
};

function initialLang() {
  try {
    const stored = localStorage.getItem('rgm.lang');
    if (DOCS[stored]) return stored;
  } catch { /* private mode: fall through */ }
  const fromBrowser = (navigator.language ?? '').slice(0, 2);
  return DOCS[fromBrowser] ? fromBrowser : 'vi';
}

let lang = initialLang();

function render() {
  const doc = DOCS[lang];
  document.documentElement.lang = doc.htmlLang;
  document.title = doc.title;
  document.getElementById('langs').innerHTML = Object.entries({ vi: 'Tiếng Việt', zh: '中文', en: 'English' })
    .map(([code, label]) =>
      `<button class="${code === lang ? 'on' : ''}" data-lang="${code}">${label}</button>`)
    .join('');
  document.getElementById('doc').innerHTML = `
    <h1>${doc.h1}</h1>
    <p class="lead">${doc.lead}</p>
    ${doc.sections.map((s) => `<h2>${s.h}</h2>${s.body(lang)}`).join('')}`;
}

document.getElementById('langs').addEventListener('click', (ev) => {
  const code = ev.target?.dataset?.lang;
  if (!DOCS[code] || code === lang) return;
  lang = code;
  try { localStorage.setItem('rgm.lang', lang); } catch { /* nothing to do */ }
  render();
});

render();
