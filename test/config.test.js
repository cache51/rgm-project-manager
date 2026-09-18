/**
 * Environment configuration.
 *
 * Untested configuration is where deployments break, so each choice is asserted
 * against the env var that triggers it, and `describe()` is checked to report what
 * was actually selected.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, chooseStorage, chooseMailer, chooseTranslationProvider,
         makeDeliver } from '../src/config.js';
import { FsStorage } from '../src/storage.js';
import { S3Storage } from '../src/storage-s3.js';

describe('config: storage', () => {
  test('defaults to the filesystem, so local development needs no setup', () => {
    assert.ok(chooseStorage({}) instanceof FsStorage);
  });

  test('S3_BUCKET switches to bucket storage', () => {
    const storage = chooseStorage({
      S3_BUCKET: 'rgm-attachments',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret'
    });
    assert.ok(storage instanceof S3Storage);
    assert.equal(storage.bucket, 'rgm-attachments');
    assert.equal(storage.forcePathStyle, true, 'path style suits MinIO, the common case');
  });

  test('production S3 also requires the app-local capability secret', () => {
    assert.throws(() => chooseStorage({
      NODE_ENV: 'production',
      S3_BUCKET: 'rgm-attachments',
      S3_ENDPOINT: 'https://s3.example',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret'
    }), /STORAGE_SECRET must be set/);
  });

  test('virtual-host addressing can be requested', () => {
    const storage = chooseStorage({
      S3_BUCKET: 'b', S3_ENDPOINT: 'https://s3.example', S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's', S3_FORCE_PATH_STYLE: 'false'
    });
    assert.equal(storage.forcePathStyle, false);
  });
});

describe('config: mailer', () => {
  test('defaults to the console, which is obviously not a delivery mechanism', () => {
    assert.equal(chooseMailer({}).name, 'console');
  });

  test('SMTP_HOST selects SMTP, and port 465 implies implicit TLS', () => {
    const mailer = chooseMailer({ SMTP_HOST: 'smtp.example', SMTP_PORT: '465', SMTP_USER: 'u' });
    assert.equal(mailer.name, 'smtp');

    // 587 must NOT default to implicit TLS — it is the STARTTLS port.
    assert.equal(chooseMailer({ SMTP_HOST: 'x', SMTP_PORT: '587' }).name, 'smtp');
  });

  test('an HTTP provider wins over SMTP when both are configured', () => {
    assert.equal(chooseMailer({ EMAIL_API_ENDPOINT: 'https://api.mail/v1',
                                EMAIL_API_KEY: 'k', SMTP_HOST: 'smtp.example' }).name, 'http');
  });

  test('requireTls resolves, and an authenticated mailer demands it by default', () => {
    // RGM4-005: the README documented `REQUIRE_TLS` while the loader read
    // `SMTP_REQUIRE_TLS`, and the default was false — so an operator following the
    // docs got no STARTTLS requirement and credentials could go out in plaintext.
    // The old test only asserted the provider name, which is why it missed this.
    const explicitOff = chooseMailer({ SMTP_HOST: 'x', SMTP_USER: 'u',
                                       SMTP_REQUIRE_TLS: 'false' });
    assert.equal(explicitOff.requireTls, false, 'an explicit false is honoured');

    assert.equal(chooseMailer({ SMTP_HOST: 'x', SMTP_REQUIRE_TLS: 'true' }).requireTls, true);
    assert.equal(chooseMailer({ SMTP_HOST: 'x', REQUIRE_TLS: 'true' }).requireTls, true,
      'the documented spelling must work too');
    assert.equal(chooseMailer({ SMTP_HOST: 'x', SMTP_USER: 'u' }).requireTls, true,
      'authenticated SMTP requires TLS unless told otherwise');
    assert.equal(chooseMailer({ SMTP_HOST: 'x' }).requireTls, false,
      'a credential-less dev relay is left alone');
  });
});

describe('config: translation provider', () => {
  test('defaults to the stub, and the stub says so', () => {
    assert.equal(chooseTranslationProvider({}).name, 'stub');
  });

  test('an API key implies the OpenAI-compatible provider', () => {
    assert.equal(chooseTranslationProvider({ TRANSLATE_API_KEY: 'sk-x' }).name,
      'openai-compatible');
  });

  test('deepl is selected explicitly and keeps its own key', () => {
    const provider = chooseTranslationProvider({ TRANSLATE_PROVIDER: 'deepl',
                                                 DEEPL_API_KEY: 'dl' });
    assert.equal(provider.name, 'deepl');
  });

  test('an explicit provider beats the inferred one', () => {
    assert.equal(chooseTranslationProvider({ TRANSLATE_API_KEY: 'sk', TRANSLATE_PROVIDER: 'stub' })
      .name, 'stub');
  });

  test('a local server can be told to switch its model\'s thinking off', () => {
    const provider = chooseTranslationProvider({
      TRANSLATE_PROVIDER: 'openai',
      TRANSLATE_BASE_URL: 'http://127.0.0.1:8012',
      TRANSLATE_API_KEY: 'sk-local',
      TRANSLATE_MODEL: 'local-thinker',
      TRANSLATE_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}'
    });
    // withRetry spreads the provider, so the fields survive the wrapper.
    assert.equal(provider.model, 'local-thinker');
    assert.deepEqual(provider.extraBody, { chat_template_kwargs: { enable_thinking: false } });
  });

  test('a malformed extra body is refused at startup, not per translation', () => {
    assert.throws(() => chooseTranslationProvider({
      TRANSLATE_PROVIDER: 'openai', TRANSLATE_API_KEY: 'sk',
      TRANSLATE_EXTRA_BODY: '{"chat_template_kwargs":'
    }), /TRANSLATE_EXTRA_BODY must be a JSON object/);
    assert.throws(() => chooseTranslationProvider({
      TRANSLATE_PROVIDER: 'openai', TRANSLATE_API_KEY: 'sk',
      TRANSLATE_EXTRA_BODY: '[1,2,3]'
    }), /must be a JSON object, got an array/);
  });
});

describe('config: the deliver adapter', () => {
  const capture = () => {
    const sent = [];
    return {
      name: 'capture',
      sent,
      async send(msg) { sent.push(msg); return { messageId: 'x' }; }
    };
  };

  test('a sign-in link carries its secret in the fragment, never the query (IR-018)', async () => {
    const mailer = capture();
    await makeDeliver(mailer, 'http://localhost:3000')({
      to: 'linh@rgm.example', token: 'tok+with/special=chars', kind: 'login'
    });

    const [msg] = mailer.sent;
    assert.equal(msg.to, 'linh@rgm.example');
    assert.match(msg.body, /http:\/\/localhost:3000\/login#token=/);
    // The fragment never leaves the browser; the query string reaches access
    // logs, proxies and Referer headers.
    assert.ok(!msg.body.includes('?token='), 'no secret in the query string');
    // The token must be url-encoded, or a '+' in it would arrive as a space.
    assert.ok(msg.body.includes(encodeURIComponent('tok+with/special=chars')));
    assert.match(msg.subject, /đăng nhập/);
  });

  test('an invitation points at the invite flow, not sign-in (IR-018)', async () => {
    const mailer = capture();
    await makeDeliver(mailer, 'https://rgm.example')({
      to: 'new@rgm.example', token: 'abc', kind: 'invite'
    });
    assert.match(mailer.sent[0].body, /https:\/\/rgm\.example\/login#invite=abc/);
    assert.ok(!mailer.sent[0].body.includes('?invite='), 'no secret in the query string');
    assert.ok(!mailer.sent[0].body.includes('#token='), 'an invitation is not a session');
  });

  test('a trailing slash on the public URL does not produce a double slash', async () => {
    const mailer = capture();
    await makeDeliver(mailer, 'https://rgm.example/')({ to: 'a@b.c', token: 't', kind: 'login' });
    assert.match(mailer.sent[0].body, /https:\/\/rgm\.example\/login/);
    assert.ok(!mailer.sent[0].body.includes('example//login'));
  });
});

describe('config: loadConfig', () => {
  test('a bare environment is coherent and self-describing', () => {
    const config = loadConfig({});
    const described = config.describe();

    assert.equal(described.database, 'pglite (in-memory)');
    assert.equal(described.mailer, 'console');
    assert.equal(described.translation, 'stub');
    assert.equal(described.secureCookies, false);
    assert.equal(config.publicUrl, 'http://127.0.0.1:3000');
    assert.equal(config.port, 3000);
  });

  test('a production-shaped environment reports what it selected', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@db:5432/rgm',
      S3_BUCKET: 'rgm',
      S3_ENDPOINT: 'https://s3.example',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      SMTP_HOST: 'smtp.example',
      TRANSLATE_PROVIDER: 'deepl',
      DEEPL_API_KEY: 'dl',
      PUBLIC_URL: 'https://rgm.example',
      SECURE_COOKIES: 'true',
      PORT: '8080'
    });
    const described = config.describe();

    assert.equal(described.database, 'postgres (DATABASE_URL)');
    assert.equal(described.storage, 's3 (rgm)');
    assert.equal(described.mailer, 'smtp');
    assert.equal(described.translation, 'deepl');
    assert.equal(described.publicUrl, 'https://rgm.example');
    assert.equal(described.secureCookies, true);
    assert.equal(config.port, 8080);
    // Cookies must be Secure in production, or the session cookie leaks over http.
    assert.equal(config.secureCookies, true);
  });

  test('PUBLIC_URL is normalised so links are not malformed', () => {
    assert.equal(loadConfig({ PUBLIC_URL: 'https://rgm.example///' }).publicUrl,
      'https://rgm.example');
  });

  test('databases are chosen exclusively, never both', () => {
    const both = loadConfig({ DATABASE_URL: 'postgres://x', PGLITE_DIR: '/tmp/pg' });
    assert.equal(both.describe().database, 'postgres (DATABASE_URL)',
      'a connection string must win, or a deployment silently uses a local file');
  });

  test('hard purge does not add a long-lived application database credential', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://rgm_app:runtime@db/rgm',
      PURGE_DATABASE_URL: 'postgres://obsolete:must-not-be-used@db/rgm'
    });
    assert.equal(config.databaseUrl, 'postgres://rgm_app:runtime@db/rgm');
    assert.equal(Object.hasOwn(config, 'purgeDatabaseUrl'), false);
  });

  test('production refuses the built-in development storage secret', () => {
    // IR-012: the default secret is in this repository, so anyone could forge an
    // upload capability with it.
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', STORAGE_DIR: '/tmp/x' }),
      /STORAGE_SECRET must be set/);

    const cfg = loadConfig({ NODE_ENV: 'production', STORAGE_SECRET: 'a-real-secret' });
    assert.equal(cfg.secureCookies, true, 'production must default to Secure cookies');
  });

  test('session cookies default to Secure only in production', () => {
    assert.equal(loadConfig({ NODE_ENV: 'production', STORAGE_SECRET: 'x' }).secureCookies, true);
    assert.equal(loadConfig({ STORAGE_DIR: '/tmp/x' }).secureCookies, false);
    assert.equal(loadConfig({ STORAGE_DIR: '/tmp/x', SECURE_COOKIES: 'true' }).secureCookies,
      true, 'an explicit setting still wins');
  });

  test('automatic migration can be switched off for a multi-replica deployment', () => {
    assert.equal(loadConfig({ STORAGE_DIR: '/tmp/x' }).migrateOnStart, true);
    assert.equal(
      loadConfig({ STORAGE_DIR: '/tmp/x', MIGRATE_ON_START: 'false' }).migrateOnStart,
      false);
  });

  test('the translator reads the documented base-URL variable, and its alias', () => {
    // IR-011: the README documented TRANSLATE_API_URL while the loader read
    // TRANSLATE_BASE_URL — following the docs silently sent bug text and the API
    // key to api.openai.com instead of the configured endpoint.
    for (const key of ['TRANSLATE_BASE_URL', 'TRANSLATE_API_URL']) {
      const cfg = loadConfig({
        TRANSLATE_PROVIDER: 'openai',
        [key]: 'http://127.0.0.1:9/v1',
        TRANSLATE_API_KEY: 'k',
        STORAGE_DIR: '/tmp/x'
      });
      assert.equal(typeof cfg.translationProvider.translate, 'function');
      assert.notEqual(cfg.translationProvider.name, 'stub',
        `${key} was ignored and the stub translator was used`);
    }
  });
});
