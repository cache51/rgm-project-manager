/**
 * The three dictionaries, and the labels that reach the screen.
 *
 * `t()` falls back silently — `T[lang][key] ?? T.en[key] ?? key` — so a key that is
 * missing from Vietnamese quietly shows English, and nobody notices until a tester
 * using it does. Nothing was checking that the dictionaries agree, which makes every
 * label edit (like shortening the title label) an opportunity to half-translate one.
 *
 * The keys are read out of the source rather than exported: the dictionary is a `const`
 * inside a script, so running it in a VM does not put it on the context.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp, settle } from './ui-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');

/** The body of one language's dictionary: `  en: { … }`. */
function dictionary(lang) {
  const start = SOURCE.indexOf(`\n  ${lang}: {`);
  assert.ok(start > -1, `no ${lang} dictionary`);
  const end = SOURCE.indexOf('\n  }', start);
  return SOURCE.slice(start, end);
}

/** Keys in a language block. Requires a comma or brace before them, so the `:id` of a
 *  path inside a value (`/api/bugs/:id/prompt`) is not mistaken for a key. */
function keys(lang) {
  const body = dictionary(lang);
  const found = new Set();
  for (const m of body.matchAll(/(?:[,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) found.add(m[1]);
  return found;
}

/** The value of one key, as written. Values are quoted either way, so accept both. */
function value(lang, key) {
  const m = dictionary(lang).match(
    new RegExp(`[,{]\\s*${key}\\s*:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`));
  assert.ok(m, `${key} is missing from ${lang}`);
  return m[1] ?? m[2];
}

/** The label belonging to one field, by the field's id. */
function labelFor(html, id) {
  const m = html.match(new RegExp(
    `<label[^>]*>([^<]*)</label>\\s*<(?:input|textarea|select)[^>]*id="${id}"`));
  return m?.[1];
}

const LANGS = ['vi', 'zh', 'en'];

describe('the language dictionaries', () => {
  test('all three carry the same keys', () => {
    const en = keys('en');
    assert.ok(en.size > 50, `only found ${en.size} keys in English — the parse broke`);

    for (const lang of LANGS) {
      const have = keys(lang);
      const missing = [...en].filter((k) => !have.has(k));
      const extra = [...have].filter((k) => !en.has(k));
      assert.deepEqual(missing, [], `${lang} is missing: ${missing.join(', ')}`);
      assert.deepEqual(extra, [], `${lang} has keys English does not: ${extra.join(', ')}`);
    }
  });

  test('no label is left empty', () => {
    for (const lang of LANGS) {
      for (const key of keys(lang)) {
        assert.ok(value(lang, key).trim().length > 0, `${lang}.${key} is blank`);
      }
    }
  });

  test('the title label is just the word, in every language', () => {
    // It read "Title (Vietnamese)" / "Tiêu đề (Tiếng Việt)" / "標題(越南文)" — the
    // qualifier is redundant: everything a tester types in this field is Vietnamese,
    // and saying so on every form implies the other fields might not be.
    assert.equal(value('en', 'titleL'), 'Title');
    assert.equal(value('vi', 'titleL'), 'Tiêu đề');
    assert.equal(value('zh', 'titleL'), '標題');

    for (const lang of LANGS) {
      assert.doesNotMatch(value(lang, 'titleL'), /Vietnamese|Tiếng Việt|越南文/,
        `${lang} still qualifies the title label`);
    }
  });
});

describe('the labels as they actually reach the screen', () => {
  const me = {
    userId: 'u1', email: 't@b.test', isSiteAdmin: false,
    projects: [{ id: 'p1', name: 'Packing', role: 'tester' }]
  };
  const routes = {
    'GET /api/me': me,
    'GET /api/projects': { projects: me.projects },
    'GET /api/projects/p1/milestones': {
      milestones: [{ id: 'm1', code: 'M1', title_en: 'First cut', status: 'ready',
                     ready_count: 0, availableActions: [{ action: 'start', to: 'in_progress' }] }]
    },
    'GET /api/projects/p1/bugs': { bugs: [], openCount: 0 },
    'GET /api/projects/p1/milestones/removed': { milestones: [] },
    'GET /api/projects/removed': { projects: [] }
  };

  test('the report form asks for a Title, in the language you are reading', async () => {
    const app = loadApp({ routes, browserLang: 'en-GB' });
    await settle();
    await app.click('report', { ms: 'm1' });

    // The label belonging to the title field itself, not just the first label on the
    // form — the milestone and severity fields come first.
    assert.equal(labelFor(app.html(), 'f-title'), 'Title',
      'and nothing about which language to write it in');

    for (const [lang, expected] of [['vi', 'Tiêu đề'], ['zh', '標題']]) {
      await app.click('lang', { lang });
      assert.equal(labelFor(app.html(), 'f-title'), expected,
        `the ${lang} form asks for ${expected}`);
    }
  });
});
