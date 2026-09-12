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
const heading = document.getElementById('heading');
const note = document.getElementById('note');
const field = document.getElementById('field');
const submit = document.getElementById('submit');
const hint = document.getElementById('hint');
const form = document.getElementById('form');

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
    const next = params.get('next');
    location.replace(next && next.startsWith('/') ? next : '/');
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
