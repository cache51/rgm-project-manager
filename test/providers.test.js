/**
 * Real providers: SMTP delivery and HTTP translation APIs.
 *
 * Both are exercised against local servers that speak the actual protocol, so the
 * client code is tested rather than assumed. The SMTP stub implements enough of
 * RFC 5321 to reject a malformed conversation.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SmtpMailer, HttpMailer, buildMessage, encodeHeader,
         ConsoleMailer } from '../src/mailer.js';
import { OpenAiCompatibleProvider, DeepLProvider, withRetry,
         buildTranslationPrompt } from '../src/translate-providers.js';
import { runBugTranslations } from '../src/translate.js';
import { composeNotification } from '../src/notify.js';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';

// ───────────────────────── a fake SMTP server ─────────────────────────

function startSmtpServer({ offerStartTls = false, dataReply = 250, fragment = false,
                           authDeny = false } = {}) {
  const messages = [];
  const transcript = [];

  const server = createTcpServer((socket) => {
    let buffer = '';
    let inData = false;
    let dataLines = [];
    let envelope = { from: null, to: [] };
    let authState = null;

    /**
     * Write a response. With `fragment`, each line is delivered as two pieces on
     * separate ticks, forcing the client's reader to reassemble it — the case
     * that used to desynchronise.
     *
     * The pieces are queued and flushed strictly in order. A naive
     * `write(first); setImmediate(write(rest))` interleaves the halves of
     * consecutive responses and garbles the stream, which is a bug in the test
     * double rather than in the client.
     */
    const queue = [];
    let flushing = false;
    const flush = () => {
      if (flushing || !queue.length) return;
      flushing = true;
      socket.write(queue.shift(), () => {
        flushing = false;
        if (queue.length) setImmediate(flush);
      });
    };
    const write = (line) => {
      if (fragment && line.length > 5) {
        queue.push(line.slice(0, 4), `${line.slice(4)}\r\n`);
      } else {
        queue.push(`${line}\r\n`);
      }
      flush();
    };
    /** Close only once every queued fragment has actually gone out. */
    const endWhenDrained = () => {
      if (flushing || queue.length) { setImmediate(endWhenDrained); return; }
      socket.end();
    };
    write('220 fake.rgm ESMTP');

    const handle = (line) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push({ envelope: { ...envelope }, wire: dataLines.join('\r\n') });
          dataLines = [];
          envelope = { from: null, to: [] };
          // RFC 5321: "reply-line = code SP text CRLF" — the space is required.
          write(`${dataReply} ${dataReply === 250 ? 'queued' : 'rejected'}`);
          return;
        }
        // undo dot-stuffing, as a real server does
        dataLines.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }

      transcript.push(line);
      const upper = line.toUpperCase();

      // AUTH LOGIN is a three-step conversation: challenge, username, password.
      // With authDeny the server rejects AND echoes the credential back, which is
      // what a real misconfigured server does.
      if (authState === 'user') {
        if (authDeny) {
          authState = null;
          write(`535 authentication failed for ${line}`);
          return;
        }
        authState = 'pass';
        write('334 UGFzc3dvcmQ6');
        return;
      }
      if (authState === 'pass') { authState = null; write('235 authenticated'); return; }

      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        write('250-fake.rgm');
        if (offerStartTls) write('250-STARTTLS');
        write('250-AUTH LOGIN PLAIN');
        write('250 SIZE 10485760');
        return;
      }
      if (upper === 'STARTTLS') {
        write(offerStartTls ? '220 go ahead' : '502 not implemented');
        return;
      }
      if (upper === 'AUTH LOGIN') { authState = 'user'; write('334 VXNlcm5hbWU6'); return; }
      if (upper.startsWith('MAIL FROM')) {
        envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? null; write('250 ok'); return;
      }
      if (upper.startsWith('RCPT TO')) {
        envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? null); write('250 ok'); return;
      }
      if (upper === 'DATA') { inData = true; dataLines = []; write('354 end with .'); return; }
      if (upper === 'QUIT') { write('221 bye'); endWhenDrained(); return; }
      write('500 unrecognised');
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handle(line);
      }
    });
    socket.on('error', () => { /* client hung up */ });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        messages,
        transcript,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/** Decode the base64 body back out of the wire message. */
function decodeBody(wire) {
  const [, body] = wire.split('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('smtp mailer', () => {
  let smtp;
  before(async () => { smtp = await startSmtpServer(); });
  after(async () => { await smtp.close(); });

  test('delivers a message with non-ascii content intact', async () => {
    const mailer = SmtpMailer({
      host: '127.0.0.1', port: smtp.port, user: 'rgm', pass: 'secret',
      from: 'no-reply@rgm.local'
    });

    const { messageId } = await mailer.send({
      to: 'linh@rgm.example',
      subject: 'Milestone M3 sẵn sàng kiểm thử 里程碑',
      body: 'Xin chào, cột mốc M3 đã sẵn sàng.\n\nThùng thứ 3 thiếu 3 cái.'
    });

    assert.ok(messageId, 'a message id is returned');
    assert.equal(smtp.messages.length, 1);

    const [msg] = smtp.messages;
    assert.deepEqual(msg.envelope.to, ['linh@rgm.example']);
    assert.equal(msg.envelope.from, 'no-reply@rgm.local');
    assert.equal(decodeBody(msg.wire), 'Xin chào, cột mốc M3 đã sẵn sàng.\n\nThùng thứ 3 thiếu 3 cái.',
      'the Vietnamese body must survive the round trip');

    // The subject is an encoded-word, as required for non-ASCII headers.
    const subjectLine = msg.wire.split('\r\n').find((l) => l.startsWith('Subject: '));
    assert.match(subjectLine, /=\?UTF-8\?B\?/);
    const decoded = Buffer.from(subjectLine.split('?B?')[1].replace('?=', ''), 'base64').toString('utf8');
    assert.equal(decoded, 'Milestone M3 sẵn sàng kiểm thử 里程碑');
  });

  test('authenticates before sending', async () => {
    assert.ok(smtp.transcript.some((l) => l === 'AUTH LOGIN'), 'AUTH LOGIN was sent');
    // The password is base64 of 'secret' — sent, not logged in the clear.
    assert.ok(smtp.transcript.includes(Buffer.from('secret').toString('base64')));
  });

  test('the Message-ID derives from the idempotency key, so a retry dedupes', async () => {
    const mailer = SmtpMailer({ host: '127.0.0.1', port: smtp.port, from: 'no-reply@rgm.local' });
    const key = `milestone.ready:${randomUUID()}:gen1:${randomUUID()}`;

    const first = await mailer.send({ to: 'a@b.c', subject: 's', body: 'b', idempotencyKey: key });
    const second = await mailer.send({ to: 'a@b.c', subject: 's', body: 'b', idempotencyKey: key });

    assert.equal(first.messageId, second.messageId,
      'the same key must produce the same Message-ID, or a retry double-sends');
    assert.ok(!first.messageId.includes(':'), 'the id must be a valid token');
  });

  test('a server error is raised, not swallowed', async () => {
    const failing = await startSmtpServer({ dataReply: 554 });
    try {
      const mailer = SmtpMailer({ host: '127.0.0.1', port: failing.port, from: 'x@y.z' });
      await assert.rejects(
        () => mailer.send({ to: 'a@b.c', subject: 's', body: 'b' }),
        /554/);
    } finally { await failing.close(); }
  });

  test('requireTls refuses to send in the clear when STARTTLS is unavailable', async () => {
    const plain = await startSmtpServer({ offerStartTls: false });
    try {
      const mailer = SmtpMailer({ host: '127.0.0.1', port: plain.port,
                                  from: 'x@y.z', requireTls: true });
      await assert.rejects(
        () => mailer.send({ to: 'a@b.c', subject: 's', body: 'b' }),
        /does not offer STARTTLS/);
      assert.equal(plain.messages.length, 0, 'nothing may be delivered');
    } finally { await plain.close(); }
  });

  test('a server that splits its replies mid-line is still handled', async () => {
    // Regression: the reader used to accept an unterminated line that merely
    // looked like a complete response, which desynchronised the conversation and
    // hung until the socket timed out. This server writes in two fragments.
    const fragmented = await startSmtpServer({ fragment: true });
    try {
      const mailer = SmtpMailer({
        host: '127.0.0.1', port: fragmented.port, from: 'no-reply@rgm.local',
        user: 'rgm', pass: 'secret', timeoutMs: 5000
      });
      await mailer.send({ to: 'a@b.c', subject: 'fragmented', body: 'still works' });
      assert.equal(fragmented.messages.length, 1);
      assert.equal(decodeBody(fragmented.messages[0].wire), 'still works');
    } finally { await fragmented.close(); }
  });

  test('a readiness email carries the application URL, not the placeholder', () => {
    // IR-024: the URL is worker configuration, not an outbox column — reading
    // `n.baseUrl` always fell back to the placeholder.
    const message = composeNotification(
      { kind: 'milestone.ready', payload: { milestoneCode: 'M3' }, dedupe_key: 'k' },
      { baseUrl: 'https://rgm.example' });
    assert.match(message.body, /https:\/\/rgm\.example/);
    assert.ok(!message.body.includes('chưa cấu hình'),
      'the placeholder means the configured URL never reached the composer');
  });

  test('a rejected AUTH does not leak the credential into the error', async () => {
    // IR-007: the base64 credential used to appear in the thrown message, which
    // notify.js persists to the outbox and worker.js prints.
    const denied = await startSmtpServer({ authDeny: true });
    try {
      const mailer = SmtpMailer({
        host: '127.0.0.1', port: denied.port, from: 'no-reply@rgm.local',
        user: 'rgm', pass: 'hunter2'
      });
      const userB64 = Buffer.from('rgm').toString('base64');
      const passB64 = Buffer.from('hunter2').toString('base64');

      await assert.rejects(
        () => mailer.send({ to: 'a@b.c', subject: 's', body: 'b' }),
        (err) => {
          assert.ok(!err.message.includes(userB64), `leaked the username: ${err.message}`);
          assert.ok(!err.message.includes(passB64), `leaked the password: ${err.message}`);
          assert.match(err.message, /\(redacted\)/);
          return true;
        });
    } finally {
      await denied.close();
    }
  });

  test('a connection failure surfaces as an error', async () => {
    const mailer = SmtpMailer({ host: '127.0.0.1', port: 1, from: 'x@y.z', timeoutMs: 500 });
    await assert.rejects(() => mailer.send({ to: 'a@b.c', subject: 's', body: 'b' }));
  });

  test('body encoding cannot forge the end-of-data sequence', () => {
    // Base64 output never begins a line with '.', so dot-stuffing is unnecessary
    // and '\r\n.\r\n' cannot appear in the payload.
    const { wire } = buildMessage({
      from: 'a@b.c', to: 'd@e.f', subject: 's',
      body: 'line one\r\n.\r\nSMTP INJECTION ATTEMPT'
    });
    const body = wire.split('\r\n\r\n')[1];
    assert.ok(!/\r\n\.\r\n/.test(body), 'the terminator must not be forgeable');
    assert.ok(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString()
      .includes('SMTP INJECTION ATTEMPT'), 'the text is still delivered verbatim');
  });

  test('headers that are already ascii are left alone', () => {
    assert.equal(encodeHeader('plain subject'), 'plain subject');
    assert.notEqual(encodeHeader('có dấu'), 'có dấu');
  });

  test('the console mailer is clearly not a delivery mechanism', async () => {
    const lines = [];
    const mailer = ConsoleMailer((line) => lines.push(line));
    await mailer.send({ to: 'a@b.c', subject: 's', body: 'hello' });
    assert.match(lines.join('\n'), /\[mail\] to=a@b\.c/);
    assert.match(lines.join('\n'), /hello/);
  });
});

// ───────────────────────── provider endpoints ─────────────────────────

function startHttpStub(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      const record = { method: req.method, url: req.url, headers: req.headers, json, raw };
      requests.push(record);
      handler(record, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((r) => server.close(r))
    }));
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('translation providers', () => {
  test('the prompt carries the glossary, which is what protects domain terms', () => {
    const prompt = buildTranslationPrompt({
      text: 'Thùng bị thiếu', from: 'vi', to: 'zh',
      glossary: { carton: 'thùng', techpack: 'techpack' }
    });
    assert.match(prompt, /Traditional Chinese/);
    assert.match(prompt, /carton => thùng/);
    assert.match(prompt, /<<<TEXT>>>/);
    assert.match(prompt, /^Translate the following Vietnamese/m);
  });

  test('an OpenAI-compatible provider sends the text and returns the translation', async () => {
    const stub = await startHttpStub((req, res) => json(res, 200, {
      choices: [{ message: { content: '  第3箱少3個  ' } }]
    }));
    try {
      const provider = OpenAiCompatibleProvider({
        baseUrl: stub.url, apiKey: 'sk-test', model: 'gpt-4o-mini'
      });
      const out = await provider.translate({ text: 'Thùng 3 thiếu 3 cái', to: 'zh' });
      assert.equal(out, '第3箱少3個', 'the result is trimmed');

      const [req] = stub.requests;
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer sk-test');
      assert.equal(req.json.model, 'gpt-4o-mini');
      assert.equal(req.json.temperature, 0, 'deterministic by default');
      assert.match(req.json.messages[0].content, /Thùng 3 thiếu 3 cái/);
    } finally { await stub.close(); }
  });

  test('extra body fields reach the wire without displacing the text', async () => {
    const stub = await startHttpStub((req, res) => json(res, 200, {
      choices: [{ message: { content: 'ok' } }]
    }));
    try {
      // A local thinking model: without this the request runs for minutes.
      const provider = OpenAiCompatibleProvider({
        baseUrl: stub.url, apiKey: 'sk-test', model: 'local-thinker',
        extraBody: { chat_template_kwargs: { enable_thinking: false }, max_tokens: 512 }
      });
      await provider.translate({ text: 'Thùng 3 thiếu 3 cái', to: 'zh' });

      const [req] = stub.requests;
      assert.deepEqual(req.json.chat_template_kwargs, { enable_thinking: false });
      assert.equal(req.json.max_tokens, 512);
      assert.match(req.json.messages[0].content, /Thùng 3 thiếu 3 cái/,
        'extra fields must not be able to displace the text being translated');
    } finally { await stub.close(); }
  });

  test('a provider that never answers is abandoned at the timeout', async () => {
    // The socket is accepted and then ignored, which is what a hung model looks
    // like from here: without a timeout the worker would wait forever.
    const stub = await startHttpStub(() => {});
    try {
      const provider = OpenAiCompatibleProvider({
        baseUrl: stub.url, apiKey: 'sk-test', timeoutMs: 150
      });
      await assert.rejects(() => provider.translate({ text: 'x', to: 'zh' }),
        /abort/i);
    } finally { await stub.close(); }
  });

  test('a provider error surfaces its own message, so the failure is diagnosable', async () => {
    const stub = await startHttpStub((req, res) =>
      json(res, 429, { error: { message: 'rate limited, retry later' } }));
    try {
      const provider = OpenAiCompatibleProvider({ baseUrl: stub.url, apiKey: 'k' });
      await assert.rejects(
        () => provider.translate({ text: 'x', to: 'zh' }),
        /429.*rate limited/s);
    } finally { await stub.close(); }
  });

  test('an empty completion is an error, not an empty translation', async () => {
    const stub = await startHttpStub((req, res) => json(res, 200, { choices: [{ message: {} }] }));
    try {
      const provider = OpenAiCompatibleProvider({ baseUrl: stub.url, apiKey: 'k' });
      await assert.rejects(() => provider.translate({ text: 'x', to: 'zh' }), /no content/);
    } finally { await stub.close(); }
  });

  test('the DeepL provider maps languages and passes the glossary id', async () => {
    const stub = await startHttpStub((req, res) =>
      json(res, 200, { translations: [{ text: '第3箱少3個', detected_source_language: 'VI' }] }));
    try {
      const provider = DeepLProvider({
        endpoint: `${stub.url}/v2/translate`, apiKey: 'dl-test',
        glossaryIds: { zh: 'glossary-zh' }
      });
      const out = await provider.translate({ text: 'Thùng 3 thiếu 3 cái', to: 'zh' });
      assert.equal(out, '第3箱少3個');

      const [req] = stub.requests;
      assert.equal(req.headers.authorization, 'DeepL-Auth-Key dl-test');
      assert.equal(req.json.source_lang, 'VI');
      // Traditional Chinese, not ZH — the developer asked for 繁體.
      assert.equal(req.json.target_lang, 'ZH-HANT');
      assert.equal(req.json.glossary_id, 'glossary-zh');
      assert.deepEqual(req.json.text, ['Thùng 3 thiếu 3 cái']);
    } finally { await stub.close(); }
  });

  test('the glossary id is omitted when none is configured', async () => {
    const stub = await startHttpStub((req, res) =>
      json(res, 200, { translations: [{ text: 'ok' }] }));
    try {
      const provider = DeepLProvider({ endpoint: `${stub.url}/v2/translate`, apiKey: 'k' });
      await provider.translate({ text: 'x', to: 'en' });
      assert.equal(stub.requests[0].json.glossary_id, undefined);
      assert.equal(stub.requests[0].json.target_lang, 'EN-US');
    } finally { await stub.close(); }
  });

  test('withRetry retries a transient failure and gives up on a permanent one', async () => {
    let attempts = 0;
    const flaky = {
      name: 'flaky', model: 'm',
      async translate() {
        attempts += 1;
        if (attempts < 3) throw new Error('provider 503 temporarily unavailable');
        return 'recovered';
      }
    };
    const out = await withRetry(flaky, { attempts: 5, sleep: async () => {} })
      .translate({ text: 'x', to: 'zh' });
    assert.equal(out, 'recovered');
    assert.equal(attempts, 3);

    let permanent = 0;
    const bad = {
      name: 'bad', model: 'm',
      async translate() { permanent += 1; throw new Error('provider 403 forbidden'); }
    };
    await assert.rejects(
      () => withRetry(bad, { attempts: 5, sleep: async () => {} }).translate({ text: 'x', to: 'zh' }),
      /403/);
    assert.equal(permanent, 1, 'a 4xx must not be retried');
  });
});

describe('providers wired into the real workers', () => {
  let w, ms;
  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-PROV', 'Providers');
  });
  after(async () => { await w.close(); });

  test('a real HTTP provider drains the queue and the developer can read it', async () => {
    const stub = await startHttpStub((req, res) => json(res, 200, {
      // echo something recognisable, and include the source so we can trace it
      choices: [{ message: { content: `【zh】${/<<<TEXT>>>\n([\s\S]*?)\n<<<END TEXT>>>/.exec(req.json.messages[0].content)?.[1] ?? ''}` } }]
    }));
    try {
      const bug = await fileBug(w.testerClient, w.project.id, {
        milestoneId: ms, titleVi: 'Thiếu hàng', bodyVi: 'Thùng 3 thiếu 3 cái'
      });
      const provider = OpenAiCompatibleProvider({ baseUrl: stub.url, apiKey: 'sk' });
      const results = await runBugTranslations(w.db, provider, { workerId: randomUUID() });

      const mine = results.filter((r) => r.bugId === bug.id);
      assert.equal(mine.length, 4);
      assert.ok(mine.every((r) => r.status === 'done'), JSON.stringify(mine));

      const payload = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
      assert.match(payload.translations.body.zh.text, /^【zh】Thùng 3 thiếu 3 cái/);
      assert.equal(payload.translations.body.zh.status, 'done');

      // The provider was actually called, with the glossary, for both languages.
      assert.ok(stub.requests.length >= 4);
      assert.ok(stub.requests.every((r) => /glossary/i.test(r.json.messages[0].content)));
    } finally { await stub.close(); }
  });

  test('a provider outage marks the language failed without losing the bug', async () => {
    const stub = await startHttpStub((req, res) => json(res, 500, { error: 'down' }));
    try {
      const bug = await fileBug(w.testerClient, w.project.id, {
        milestoneId: ms, titleVi: 'Lỗi nhãn', bodyVi: 'Nhãn in lệch'
      });
      const provider = OpenAiCompatibleProvider({ baseUrl: stub.url, apiKey: 'sk' });
      const results = await runBugTranslations(w.db, provider, { workerId: randomUUID() });
      const mine = results.filter((r) => r.bugId === bug.id);
      assert.ok(mine.every((r) => r.status === 'failed'));

      const payload = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
      assert.equal(payload.status, 'new', 'the bug is still filed and readable');
      assert.equal(payload.translations.body.zh.status, 'failed');
      assert.match(payload.translations.body.zh.error, /500/);

      // And the prompt says so rather than quietly omitting the translation.
      const prompt = await w.devClient.get(`/api/bugs/${bug.id}/prompt`);
      assert.match(prompt.text, /Translation coverage: NONE/,
        'a total failure is still reported per language');
      assert.match(prompt.text, /body\/zh failed/);
      assert.match(prompt.text, /500/);
    } finally { await stub.close(); }
  });

  test('the outbox worker delivers through SMTP end to end', async () => {
    const smtp = await startSmtpServer();
    try {
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const milestone = (await w.adminClient.get(
        `/api/projects/${w.project.id}/milestones`)).json.milestones
        .find((m) => m.code === 'M-PROV');

      // Walk the milestone to ready through the API, which queues the outbox row.
      await w.adminClient.post(`/api/milestones/${milestone.id}/status`, { action: 'start' });
      await w.adminClient.post(`/api/milestones/${milestone.id}/status`, { action: 'ready' });

      const { runOutbox } = await import('../src/notify.js');
      const mailer = SmtpMailer({
        host: '127.0.0.1', port: smtp.port, from: 'no-reply@rgm.local'
      });
      const delivered = await runOutbox(w.db, mailer, { workerId: randomUUID() });
      assert.ok(delivered.length >= 1, 'the tester is notified');
      assert.ok(delivered.every((r) => r.status === 'sent'), JSON.stringify(delivered));

      assert.equal(smtp.messages.length, delivered.length);
      const recipient = smtp.messages[0].envelope.to[0];
      assert.ok(recipient.endsWith('@rgm.example'));
      // The composed body names the milestone and is in the tester's language.
      const body = decodeBody(smtp.messages[0].wire);
      assert.match(body, /M-PROV/);
      assert.match(body, /sẵn sàng để kiểm thử/);
      assert.ok(bug, 'and the bug that prompted this still exists');
    } finally { await smtp.close(); }
  });
});
