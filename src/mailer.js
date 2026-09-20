/**
 * Mailers.
 *
 * The app only needs `deliver({ to, token, kind })`, so this is another seam:
 * `src/server.js` wires one in and nothing else changes.
 *
 * Message-IDs are derived from the outbox idempotency key, matching notify.js:
 * the dedupe key becomes the RFC 5322 Message-ID, so a retry after a crash
 * produces the same Message-ID and receiving servers can discard the duplicate.
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';

/** Dev mailer: prints the link. Clearly not a delivery mechanism. */
export const ConsoleMailer = (write = (line) => process.stdout.write(line)) => ({
  name: 'console',
  async send({ to, cc = [], subject, body }) {
    write(`[mail] to=${to}${cc.length ? ` cc=${cc.join(',')}` : ''} subject=${subject}\n${body}\n`);
    return { messageId: null };
  }
});

// ───────────────────────── message construction ─────────────────────────

/** RFC 2047 encoded-word for a header that may not be ASCII. */
export function encodeHeader(value) {
  const text = String(value);
  return /^[\x20-\x7E]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/**
 * Build an RFC 5322 message.
 *
 * The body is base64, which sidesteps two problems at once: non-ASCII text in a
 * 7-bit transport, and dot-stuffing — base64 output can never produce a line
 * beginning with '.', so the terminating sequence cannot be forged from content.
 */
export function buildMessage({ from, to, cc = [], subject, body, messageId = null, date = new Date() }) {
  const id = messageId ?? `<${randomUUID()}@rgm>`;
  const wrapped = (Buffer.from(String(body), 'utf8').toString('base64')
    .match(/.{1,76}/g) ?? []).join('\r\n');
  // An empty Cc list must not print a bare `Cc:` header — receivers are the
  // envelope, and a header that promises nobody looks like a broken MUA.
  const ccHeader = cc.length ? [`Cc: ${cc.map((c) => encodeHeader(c)).join(', ')}`] : [];

  return {
    messageId: id,
    wire: [
      `Date: ${date.toUTCString()}`,
      `From: ${encodeHeader(from)}`,
      `To: ${encodeHeader(to)}`,
      ...ccHeader,
      `Subject: ${encodeHeader(subject)}`,
      `Message-ID: ${id}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapped
    ].join('\r\n')
  };
}

// ───────────────────────── minimal SMTP client ─────────────────────────

const smtpId = (key) => {
  // Message-ID must be a dot-atom-ish token; the dedupe key contains colons.
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return `<${safe}@rgm.local>`;
};

class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.closed = false;
    // Stored, not just used: startTls builds a replacement session and has to
    // carry the timeout across, and without this it passed `undefined` — which
    // silently disables the idle timeout on the secured socket (IR-006).
    this.timeoutMs = timeoutMs;
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.#drain();
    });
    const fail = (err) => this.#failAll(err instanceof Error ? err : new Error(String(err)));
    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error('SMTP: timed out')));
    socket.on('close', () => this.#failAll(new Error('SMTP: connection closed')));
  }

  /** Resolve when a complete response (final line "NNN ") has arrived. */
  #drain() {
    if (!this.waiters.length) return;
    const waiter = this.waiters[0];
    const lines = this.buffer.split('\r\n');

    // Only a CRLF-terminated line is a complete line. The last element is the
    // unterminated remainder, and treating it as complete desynchronises the
    // conversation whenever a response is split across packets — a partial
    // "250 SIZE 10485760" looks exactly like a finished one.
    const complete = lines.slice(0, -1);
    for (let i = 0; i < complete.length; i++) {
      // RFC 5321: "NNN SP text". A bare "NNN" is out of spec but tolerated —
      // refusing it would hang against a server that omits the text entirely.
      // A continuation line is "NNN-text", which must not match.
      if (/^\d{3}(?: |$)/.test(complete[i])) {
        const text = complete.slice(0, i + 1).join('\n');
        this.buffer = lines.slice(i + 1).join('\r\n');
        this.waiters.shift();
        waiter.resolve({ code: Number(complete[i].slice(0, 3)), text });
        return;
      }
    }
  }

  #failAll(err) {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  readResponse(timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('SMTP: connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error('SMTP: response timed out'));
      }, timeoutMs);
      this.waiters.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.#drain();
    });
  }

  /** Send a command and assert the response code. */
  async command(line, expect, { hidden = false } = {}) {
    this.socket.write(`${line}\r\n`);
    const res = await this.readResponse();
    const codes = Array.isArray(expect) ? expect : [expect];
    if (!codes.includes(res.code)) {
      // When the command carried a credential, the response is redacted too: a
      // server may echo the AUTH line back, and base64 is not protection. This
      // error is persisted to the outbox and printed by the worker (IR-007).
      const shown = hidden ? '(redacted)' : line;
      const detail = hidden ? '' : ` ${res.text}`;
      throw new Error(`SMTP: ${shown} → ${res.code}${detail}`);
    }
    return res;
  }

  async startTls({ rejectUnauthorized = true } = {}) {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('timeout');
    this.socket.removeAllListeners('close');

    const secured = await new Promise((resolve, reject) => {
      const tls = tlsConnect({ socket: this.socket, servername: this.servername,
        rejectUnauthorized }, () => resolve(tls));
      tls.once('error', reject);
    });
    // Replace the transport in place, keeping the same reader — and the timeout,
    // which is why the constructor stores it.
    const session = new SmtpSession(secured, this.timeoutMs);
    session.buffer = '';
    return session;
  }

  close() {
    try { this.socket.end(); } catch { /* already gone */ }
  }
}

async function openSession({ host, port, secure, timeoutMs, servername }) {
  const socket = await new Promise((resolve, reject) => {
    const s = secure
      ? tlsConnect({ host, port, servername: servername ?? host })
      : netConnect({ host, port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const session = new SmtpSession(socket, timeoutMs);
  session.servername = servername ?? host;
  return session;
}

/**
 * SMTP mailer. Supports implicit TLS (465), STARTTLS (587) and plain (1025).
 */
export function SmtpMailer({
  host, port = 587, secure = false, user = null, pass = null,
  from = 'no-reply@rgm.local', requireTls = false, timeoutMs = 15000,
  hostname = 'localhost'
}) {
  if (!host) throw new Error('SmtpMailer needs a host');

  return {
    name: 'smtp',
    // Exposed so the configuration contract can be asserted: a `requireTls` that
    // resolved to false while the docs promised otherwise is exactly how
    // credentials came to be sendable in plaintext (RGM4-005).
    requireTls,

    async send({ to, cc = [], subject, body, idempotencyKey = null }) {
      const messageId = idempotencyKey ? smtpId(idempotencyKey) : `<${randomUUID()}@rgm.local>`;
      const message = buildMessage({ from, to, cc, subject, body, messageId });

      let session = await openSession({ host, port, secure, timeoutMs });
      try {
        await session.readResponse();
        await session.command(`EHLO ${hostname}`, 250);

        if (!secure) {
          // Ask for TLS when offered; refuse to continue in the clear if required.
          const afterTls = await session.command('STARTTLS', [220, 502, 500]);
          if (afterTls.code === 220) {
            const secured = await session.startTls();
            session = secured;
            await session.command(`EHLO ${hostname}`, 250);
          } else if (requireTls) {
            throw new Error('SMTP: server does not offer STARTTLS and requireTls is set');
          }
        }

        if (user) {
          // AUTH LOGIN: the credential commands are marked hidden, so neither the
          // command nor the server's reply can reach an error message, the outbox
          // table, or the worker's log (IR-007).
          await session.command('AUTH LOGIN', 334, { hidden: true });
          await session.command(Buffer.from(user, 'utf8').toString('base64'), 334,
            { hidden: true });
          await session.command(Buffer.from(pass ?? '', 'utf8').toString('base64'), 235,
            { hidden: true });
        }

        await session.command(`MAIL FROM:<${from}>`, 250);
        // The envelope needs every recipient, Cc included — the Cc header only
        // says who should see it, the RCPT list says where the copy goes. A
        // missing RCPT is a silently undelivered person.
        const envelope = [to, ...cc].filter(Boolean);
        for (const rcpt of new Set(envelope.map((a) => String(a).toLowerCase()))) {
          await session.command(`RCPT TO:<${rcpt}>`, [250, 251]);
        }
        await session.command('DATA', 354);
        await session.command(`${message.wire}\r\n.`, 250);
        await session.command('QUIT', [221, 250]);
        return { messageId };
      } finally {
        session.close();
      }
    }
  };
}

// ───────────────────────── HTTP provider mailer ─────────────────────────

/**
 * Mailer for an HTTP email API (Resend, Postmark, Mailgun…). `shape` adapts the
 * body to the provider; the default matches Resend/Postmark-style JSON.
 */
export function HttpMailer({
  endpoint,
  apiKey,
  from,
  fetchImpl = fetch,
  headers: extraHeaders = {},
  shape = ({ to, cc, from: f, subject, text }) => ({ from: f, to, ...(cc?.length ? { cc } : {}), subject, text })
}) {
  if (!endpoint) throw new Error('HttpMailer needs an endpoint');

  return {
    name: 'http',

    async send({ to, cc = [], subject, body, idempotencyKey = null }) {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          // Same key as the SMTP Message-ID: a provider that honours this will not
          // send twice if we retry after a crash.
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...extraHeaders
        },
        body: JSON.stringify(shape({ to, cc, from, subject, text: body, idempotencyKey }))
      });

      if (!res.ok) {
        throw new Error(`mail provider ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 500));
      }
      const json = await res.json().catch(() => ({}));
      return { messageId: json.id ?? json.message_id ?? null };
    }
  };
}
