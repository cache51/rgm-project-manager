/**
 * Sign-in page: an email address, and nothing else.
 *
 * There is no password and no emailed link. A link has to be delivered to be useful,
 * and this deployment has no mailer — so every sign-in meant reading a URL out of the
 * server log, which is the machinery this replaces. The address is matched against the
 * people an admin has added, and the role comes from that membership.
 *
 * What this does not prove: that the person typing is who the address says. It is an
 * internal tool on a private network; see `directSignIn` in src/auth.js.
 */
const heading = document.getElementById('heading');
const note = document.getElementById('note');
const field = document.getElementById('field');
const submit = document.getElementById('submit');
const hint = document.getElementById('hint');
const form = document.getElementById('form');

/**
 * The page's own copy, in the three languages the app ships (vi / zh / en).
 * Chosen the same way the app chooses: a remembered choice, then the browser's
 * language, then Vietnamese. The markup starts in English so a browser with no
 * JavaScript still shows something readable.
 */
const COPY = {
  vi: {
    title: 'Đăng nhập — RGM Project Manager', heading: 'Đăng nhập',
    note: 'Nhập địa chỉ email mà quản trị đã thêm bạn vào dự án.',
    email: 'Email', submit: 'Đăng nhập', signing: 'Đang đăng nhập…',
    fail: 'Không đăng nhập được',
    hint: 'Hãy nhờ quản trị thêm địa chỉ của bạn vào dự án trước.'
  },
  zh: {
    title: '登入 — RGM Project Manager', heading: '登入',
    note: '請輸入管理員為您登記的電郵地址。',
    email: '電郵', submit: '登入', signing: '正在登入…',
    fail: '登入失敗',
    hint: '請先請管理員把您的電郵加入專案。'
  },
  en: {
    title: 'Sign in — RGM Project Manager', heading: 'Sign in',
    note: 'Enter the address an admin added you with.',
    email: 'Email', submit: 'Sign in', signing: 'Signing you in…',
    fail: 'That did not work',
    hint: 'Ask an admin to add your address to the project first.'
  }
};

function initialLang() {
  try {
    const stored = localStorage.getItem('rgm.lang');
    if (COPY[stored]) return stored;
  } catch { /* private mode: fall through to the browser language */ }
  const fromBrowser = (navigator.language ?? '').slice(0, 2);
  return COPY[fromBrowser] ? fromBrowser : 'vi';
}

(function paint() {
  const c = COPY[initialLang()];
  document.documentElement.lang = initialLang() === 'zh' ? 'zh-Hant' : initialLang();
  document.title = c.title;
  heading.textContent = c.heading;
  note.textContent = c.note;
  field.querySelector('label').textContent = c.email;
  submit.textContent = c.submit;
  form.dataset.signing = c.signing;
  form.dataset.fail = c.fail;
  form.dataset.hint = c.hint;
})();

/**
 * Wipe any secret from the address bar (IR-018).
 *
 * Links arrive as /login#token=… or /login#invite=…; older mail carried the
 * secret in the query. Either way the page never uses it: there is no token
 * sign-in here, so the value has no job once the URL is clean. Left in place
 * it would ride into history, screenshots and the next pasted URL.
 */
(function cleanAddressBar() {
  const hasSecret = location.hash.startsWith('#token=')
    || location.hash.startsWith('#invite=')
    || location.search.includes('token=')
    || location.search.includes('invite=');
  if (hasSecret) {
    history.replaceState(null, '', location.pathname);
  }
})();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  if (!email) return;

  submit.disabled = true;
  heading.textContent = form.dataset.signing;
  note.textContent = '';

  try {
    const res = await fetch('/api/auth/direct', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `sign-in failed (${res.status})`);
    }
    // One destination, always. There is no redirect parameter to validate, so there is
    // no way to aim this somewhere else.
    location.replace('/');
  } catch (err) {
    heading.textContent = form.dataset.fail;
    note.textContent = err.message;
    hint.textContent = form.dataset.hint;
  } finally {
    submit.disabled = false;
  }
});
