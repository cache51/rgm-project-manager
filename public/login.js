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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  if (!email) return;

  submit.disabled = true;
  heading.textContent = 'Signing you in…';
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
    heading.textContent = 'That did not work';
    note.textContent = err.message;
    hint.textContent = 'Ask an admin to add your address to the project first.';
  } finally {
    submit.disabled = false;
  }
});
