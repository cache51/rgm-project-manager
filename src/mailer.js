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
  async send({ to, subject, body }) {
    write(`[mail] to=${to} subject=${subject}\n${body}\n`);
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
export function buildMessage({ from, to, subject, body, messageId = null, date = new Date() }) {
  const id = messageId ?? `<${randomUUID()}@rgm>`;
  const wrapped = (Buffer.from(String(body), 'utf8').toString('base64')
    .match(/.{1,76}/g) ?? []).join('\r\n');

  return {
    messageId: id,
    wire: [
      `Date: ${date.toUTCString()}`,
      `From: ${encodeHeader(from)}`,
      `To: ${encodeHeader(to)}`,
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
      const shown = hidden ? '(redacted)' : line;
      throw new Error(`SMTP: ${shown} → ${res.code} ${res.text}`);
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
    // Replace the transport in place, keeping the same reader.
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

    async send({ to, subject, body, idempotencyKey = null }) {
      const messageId = idempotencyKey ? smtpId(idempotencyKey) : `<${randomUUID()}@rgm.local>`;
      const message = buildMessage({ from, to, subject, body, messageId });

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
          // AUTH LOGIN: credentials are base64, and the server echoes them back in
          // its error text, so those responses must never be logged verbatim.
          await session.command('AUTH LOGIN', 334);
          await session.command(Buffer.from(user, 'utf8').toString('base64'), 334);
          await session.command(Buffer.from(pass ?? '', 'utf8').toString('base64'), 235);
        }

        await session.command(`MAIL FROM:<${from}>`, 250);
        await session.command(`RCPT TO:<${to}>`, [250, 251]);
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
  shape = ({ to, from: f, subject, text }) => ({ from: f, to, subject, text })
}) {
  if (!endpoint) throw new Error('HttpMailer needs an endpoint');

  return {
    name: 'http',

    async send({ to, subject, body, idempotencyKey = null }) {
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
        body: JSON.stringify(shape({ to, from, subject, text: body, idempotencyKey }))
      });

      if (!res.ok) {
        throw new Error(`mail provider ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 500));
      }
      const json = await res.json().catch(() => ({}));
      return { messageId: json.id ?? json.message_id ?? null };
    }
  };
}
