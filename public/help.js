/**
 * Help pages (vi / zh-Hant), illustrated with screenshots of the real UI.
 *
 * The screenshots are shot against a seeded disposable instance by
 * scripts/shoot-help.mjs and live in public/help/. Each language shows its own
 * screenshots, so a Vietnamese reader never sees a Chinese screen.
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
          <p>Ô bình luận nhận nhiều dòng; bấm Ctrl+Enter để gửi.</p>`
      },
      {
        h: '5. Ảnh chụp màn hình và gói packet',
        body: (L) => `
          <p>Ảnh đính kèm hiện trong chi tiết lỗi và tải về từng cái được. Nút
          <b>⬇ Tải gói packet</b> lấy về một tệp ZIP gồm <code>bug.md</code> (bản prompt cho
          AI agent), toàn bộ ảnh chụp và siêu dữ liệu — để developer đưa thẳng vào repo.
          Tên tệp trong gói do máy chủ đặt, nên giải nén không thể ghi ra ngoài thư mục đích.</p>`
      },
      {
        h: '6. Ngôn ngữ',
        body: () => `
          <p>Đổi ngôn ngữ giao diện ở cuối thanh bên: <b>Tiếng Việt / 中文 / English</b>.
          Lựa chọn được nhớ cho lần sau. Nội dung báo cáo luôn giữ bản tiếng Việt gốc kèm
          bản dịch, bất kể ngôn ngữ giao diện.</p>`
      },
      {
        h: '7. Nhóm và vai trò',
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
          <p>留言欄可輸入多行；按 Ctrl+Enter 送出。</p>`
      },
      {
        h: '5. 螢幕截圖與 packet 檔',
        body: () => `
          <p>附件顯示在問題詳情中，可逐一下載。<b>⬇ 下載 packet</b> 會取得一個 ZIP，內含
          <code>bug.md</code>（給 AI agent 的 prompt）、全部截圖與中繼資料——供開發人員直接放進
          repo。檔內名稱由伺服器指派，因此解壓縮不會寫到目標資料夾以外。</p>`
      },
      {
        h: '6. 語言',
        body: () => `
          <p>在側欄底部切換介面語言：<b>Tiếng Việt / 中文 / English</b>，選擇會被記住。
          無論介面語言為何，回報內容永遠保留越南原文與譯文。</p>`
      },
      {
        h: '7. 團隊與角色',
        body: (L) => `
          <p>管理員以電郵加入成員並指派角色：<b>測試人員</b>（回報、確認）、
          <b>開發人員</b>（修復、關閉、重開）、<b>管理員</b>（加人、改角色、里程碑）。</p>
          ${img(L, 'team', '團隊畫面：成員與角色')}`
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
  document.getElementById('langs').innerHTML = Object.entries({ vi: 'Tiếng Việt', zh: '中文' })
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
