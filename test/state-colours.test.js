/**
 * The bug state colours must stay tellable apart.
 *
 * They did not: "fixed and waiting to be verified" was #dcfce7 and "closed" was
 * #ecfdf5 — two pale greens that read as the same chip, which is exactly what the
 * person using the list said when they saw it. A test cannot judge "looks similar", but
 * it can hold the properties that stop it happening again: distinct fills, and a
 * difference in weight (a solid chip versus a pale outlined one) rather than hue alone
 * — which also matters because red-versus-green is the commonest colour blindness.
 *
 * The values are read from the stylesheet the server actually serves.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, '..', 'public', 'styles.css'), 'utf8');

/** The declarations of one `.st.<name>` rule. */
function rule(name) {
  const m = CSS.match(new RegExp(`\\.st\\.${name}\\{([^}]*)\\}`));
  assert.ok(m, `.st.${name} is not defined`);
  const decls = {};
  for (const part of m[1].split(';')) {
    const [prop, value] = part.split(':').map((s) => s?.trim());
    if (prop && value) decls[prop] = value;
  }
  return decls;
}

/** #rrggbb to its greyscale luminance, for comparing weight rather than hue. */
function luminance(hex) {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  assert.ok(m, `${hex} is not a plain hex colour`);
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

describe('bug state colours', () => {
  test('all three states are defined', () => {
    for (const state of ['open', 'fixed', 'verified']) rule(state);
  });

  test('no two states share a fill', () => {
    const fills = ['open', 'fixed', 'verified'].map((s) => rule(s).background);
    assert.equal(new Set(fills).size, 3, `fills must differ, got ${fills.join(', ')}`);
  });

  test('waiting to be verified and done differ by weight, not just by hue', () => {
    const fixed = rule('fixed');
    const verified = rule('verified');

    // One is a solid chip (white text on a saturated fill), the other is not.
    const isSolid = (r) => /^#fff(fff)?$/i.test(r.color ?? '');
    assert.notEqual(isSolid(fixed), isSolid(verified),
      'one of the two greens must be a solid chip and the other pale, or they read alike');

    // And their greyscale weight is far enough apart to survive losing colour.
    const gap = Math.abs(luminance(fixed.background) - luminance(verified.background));
    assert.ok(gap >= 60,
      `light green and green are only ${gap} luminance apart in greyscale`);
  });

  test('the provisional state is marked by its edge, not only by being paler', () => {
    // A dashed edge is what keeps "waiting" readable next to "open" in greyscale.
    assert.equal(rule('fixed')['border'].split(' ')[1], 'dashed');
    assert.equal(rule('verified')['border'].split(' ')[1], 'solid');
  });

  test('the open state is not hue-only either', () => {
    const open = rule('open');
    assert.ok(open['border'], 'a pale red chip gets an edge so it is not just pink');
    assert.notEqual(luminance(open.background), luminance(rule('fixed').background));
  });
});
