/**
 * The help pages are a document plus screenshots, and both halves can rot on
 * their own: a renamed PNG leaves a broken image on a page a tester reads, and
 * a re-shot set can drop a file the document still names. This checks the two
 * agree, per language, without a browser.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HELP_JS = readFileSync(join(here, '..', 'public', 'help.js'), 'utf8');
const HELP_DIR = join(here, '..', 'public', 'help');

const LANGS = ['vi', 'zh'];

/** Every `img(L, 'name', …)` call in the document source. */
function referenced() {
  const names = new Set();
  for (const m of HELP_JS.matchAll(/img\(L, '([a-z-]+)'/g)) names.add(m[1]);
  return names;
}

function filesFor(lang) {
  return new Set(readdirSync(HELP_DIR)
    .filter((f) => f.startsWith(`${lang}-`) && f.endsWith('.png'))
    .map((f) => f.slice(lang.length + 1, -4)));
}

describe('the help pages', () => {
  test('every screenshot the document names exists, in both languages', () => {
    const names = referenced();
    assert.ok(names.size >= 6, `only ${names.size} figures parsed — the parse broke`);
    for (const lang of LANGS) {
      const have = filesFor(lang);
      const missing = [...names].filter((n) => !have.has(n));
      assert.deepEqual(missing, [], `${lang} is missing: ${missing.join(', ')}`);
    }
  });

  test('no screenshot sits unreferenced', () => {
    const names = referenced();
    for (const lang of LANGS) {
      const orphans = [...filesFor(lang)].filter((n) => !names.has(n));
      assert.deepEqual(orphans, [], `${lang} has unreferenced shots: ${orphans.join(', ')}`);
    }
  });

  test('both languages carry the same sections', () => {
    // The sections are built from one array per language; a section added to
    // one and not the other would ship a half-translated document.
    const counts = {};
    for (const lang of LANGS) {
      const start = HELP_JS.indexOf(`  ${lang}: {`);
      const end = HELP_JS.indexOf('\n  }', HELP_JS.indexOf('sections:', start));
      counts[lang] = (HELP_JS.slice(start, end).match(/\n        h: '/g) ?? []).length;
    }
    assert.equal(counts.vi, counts.zh, `vi has ${counts.vi} sections, zh ${counts.zh}`);
    assert.ok(counts.vi >= 6, 'the document lost whole sections');
  });
});
