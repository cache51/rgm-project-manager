/**
 * Sign-in page. Handles both halves of the magic-link flow:
 *
 *   /login?token=…   consume the link, set the session cookie, go to the app
 *   /login           request a new link
 *
 * In development the "mailer" is the server's stdout, so the page tells you where
 * to find the link rather than pretending an email was sent.
 */
const params = new URLSearchParams(location.search);
const token = params.get('token');
const invite = params.get('invite');
const heading = document.getElementById('heading');
const note = document.getElementById('note');
const field = document.getElementById('field');
const submit = document.getElementById('submit');
const hint = document.getElementById('hint');
const form = document.getElementById('form');

/** An invitation grants membership; it does not sign anyone in. */
async function acceptInvite(value) {
  heading.textContent = 'Joining the project…';
  note.textContent = '';
  field.style.display = 'none';
  submit.style.display = 'none';
  try {
    const res = await fetch('/api/invites/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: value })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message ?? `could not join (${res.status})`);
    heading.textContent = 'You have joined';
    note.textContent = 'Now enter your email address to sign in.';
    field.style.display = '';
    submit.style.display = '';
    submit.textContent = 'Send a sign-in link';
  } catch (err) {
    heading.textContent = 'That invitation did not work';
    note.textContent = err.message;
    hint.textContent = 'Invitations are single-use, expire after 72 hours, and are cancelled if '
      + 'the person is removed from the project.';
  }
}

/**
 * A same-origin path, or null.
 *
 * `startsWith('/')` is not enough for this: `//evil.test` and `/\evil.test` also
 * start with a slash, but a browser reads them as protocol-relative URLs and
 * resolves them to another host — so a sign-in link could be used to bounce someone
 * off-site. Found by this page's own test after the first version shipped.
 */
function localPath(value) {
  if (!value || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

async function consume(value) {
  heading.textContent = 'Signing you in…';
  note.textContent = '';
  field.style.display = 'none';
  submit.style.display = 'none';

  try {
    const res = await fetch('/api/auth/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: value })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `sign-in failed (${res.status})`);
    }
    location.replace(localPath(params.get('next')) ?? '/');
  } catch (err) {
    heading.textContent = 'That link did not work';
    note.textContent = err.message;
    hint.textContent = 'Links are single-use and expire after 15 minutes. Request a new one.';
    field.style.display = '';
    submit.style.display = '';
    submit.textContent = 'Send a new link';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value;
  submit.disabled = true;
  try {
    await fetch('/api/auth/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email })
    });
    // The response never reveals whether the address exists.
    heading.textContent = 'Check your inbox';
    note.textContent = `If ${email} has access, a sign-in link is on its way.`;
    field.style.display = 'none';
    submit.style.display = 'none';
    hint.textContent =
      'Running locally? The default mailer prints the link to the server console: look for "[mail] … token=…".';
  } finally {
    submit.disabled = false;
  }
});

if (token) consume(token);
else if (invite) acceptInvite(invite);
