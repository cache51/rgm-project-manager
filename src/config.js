/**
 * Environment configuration, shared by the server and the worker so the two
 * cannot disagree about which database, bucket, mailer or translation provider
 * they are using — a disagreement that shows up as a worker quietly writing to
 * the wrong place.
 *
 * Everything has a working default for local development, and every swap is one
 * env var. Nothing here reaches into the database; it only chooses an implementation.
 */
import { FsStorage } from './storage.js';
import { S3Storage } from './storage-s3.js';
import { ConsoleMailer, SmtpMailer, HttpMailer } from './mailer.js';
import { StubProvider, DEFAULT_GLOSSARY } from './translate.js';
import { DeepLProvider, OpenAiCompatibleProvider, withRetry } from './translate-providers.js';

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function chooseStorage(env = process.env) {
  if (env.S3_BUCKET) {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION ?? 'us-east-1',
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      // MinIO and most self-hosted gateways need path-style addressing;
      // AWS itself prefers virtual-host style.
      forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true)
    });
  }
  return new FsStorage({
    root: env.STORAGE_DIR ?? './.rgm/storage',
    secret: env.STORAGE_SECRET ?? 'dev-secret-change-me'
  });
}

export function chooseMailer(env = process.env) {
  if (env.EMAIL_API_ENDPOINT) {
    return HttpMailer({
      endpoint: env.EMAIL_API_ENDPOINT,
      apiKey: env.EMAIL_API_KEY,
      from: env.MAIL_FROM ?? 'no-reply@rgm.local'
    });
  }
  if (env.SMTP_HOST) {
    return SmtpMailer({
      host: env.SMTP_HOST,
      port: num(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE, num(env.SMTP_PORT, 587) === 465),
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM ?? 'no-reply@rgm.local',
      requireTls: bool(env.SMTP_REQUIRE_TLS, false)
    });
  }
  return ConsoleMailer();
}

export function chooseTranslationProvider(env = process.env) {
  const which = (env.TRANSLATE_PROVIDER ?? (env.TRANSLATE_API_KEY ? 'openai' : 'stub')).toLowerCase();

  if (which === 'deepl') {
    return withRetry(DeepLProvider({
      endpoint: env.DEEPL_ENDPOINT ?? 'https://api-free.deepl.com/v2/translate',
      apiKey: env.DEEPL_API_KEY ?? env.TRANSLATE_API_KEY,
      glossaryIds: {
        zh: env.DEEPL_GLOSSARY_ZH,
        en: env.DEEPL_GLOSSARY_EN
      }
    }), { attempts: num(env.TRANSLATE_ATTEMPTS, 3) });
  }

  if (which === 'openai') {
    return withRetry(OpenAiCompatibleProvider({
      baseUrl: env.TRANSLATE_BASE_URL ?? 'https://api.openai.com',
      apiKey: env.TRANSLATE_API_KEY,
      model: env.TRANSLATE_MODEL ?? 'gpt-4o-mini'
    }), { attempts: num(env.TRANSLATE_ATTEMPTS, 3) });
  }

  // The stub is deliberately loud about being a stub.
  return StubProvider('stub');
}

/**
 * Build the `deliver` function the auth routes need.
 *
 * The auth routes hand over `{ to, token, kind }`; only this adapter knows what a
 * sign-in or invitation message looks like. Keeping it here means the API does
 * not gain a dependency on any particular transport.
 */
export function makeDeliver(mailer, publicUrl) {
  // Normalised here rather than trusting the caller: this function is public and
  // a trailing slash would otherwise emit "https://host//login".
  const base = String(publicUrl ?? '').replace(/\/+$/, '');

  return async ({ to, token, kind }) => {
    const encoded = encodeURIComponent(token);
    const link = kind === 'invite'
      ? `${base}/login?invite=${encoded}`
      : `${base}/login?token=${encoded}`;

    const subject = kind === 'invite'
      ? '[RGM] Lời mời tham gia dự án'
      : '[RGM] Liên kết đăng nhập';

    const body = kind === 'invite'
      ? [
        'Bạn được mời tham gia một dự án trên RGM Project Manager.',
        '',
        'Mở liên kết này để tham gia, sau đó đăng nhập bằng địa chỉ email của bạn:',
        link,
        '',
        'Liên kết hết hạn sau 72 giờ.'
      ].join('\n')
      : [
        'Nhấn vào liên kết để đăng nhập:',
        link,
        '',
        'Liên kết chỉ dùng được một lần và hết hạn sau 15 phút.',
        'Nếu bạn không yêu cầu liên kết này, hãy bỏ qua email.'
      ].join('\n');

    await mailer.send({ to, subject, body });
  };
}

export function loadConfig(env = process.env) {
  const publicUrl = (env.PUBLIC_URL ?? `http://127.0.0.1:${env.PORT ?? 3000}`).replace(/\/+$/, '');
  const mailer = chooseMailer(env);

  return {
    port: num(env.PORT, 3000),
    host: env.HOST ?? '127.0.0.1',
    publicUrl,
    secureCookies: bool(env.SECURE_COOKIES, false),
    // A connection string selects node-postgres; PGLITE_DIR selects the embedded
    // database. createDb resolves the same way.
    databaseUrl: env.DATABASE_URL ?? null,
    dataDir: env.PGLITE_DIR ?? null,
    storage: chooseStorage(env),
    mailer,
    deliver: makeDeliver(mailer, publicUrl),
    translationProvider: chooseTranslationProvider(env),
    glossary: DEFAULT_GLOSSARY,
    // Surfaced so a startup log can state what was chosen, rather than leaving
    // "which mailer is this using?" to be discovered in production.
    describe() {
      return {
        database: env.DATABASE_URL ? 'postgres (DATABASE_URL)' : `pglite (${env.PGLITE_DIR ?? 'in-memory'})`,
        storage: env.S3_BUCKET ? `s3 (${env.S3_BUCKET})` : `filesystem (${env.STORAGE_DIR ?? './.rgm/storage'})`,
        mailer: mailer.name,
        translation: this.translationProvider.name,
        publicUrl,
        secureCookies: this.secureCookies
      };
    }
  };
}
