/**
 * Shoot the help-page screenshots against a seeded disposable instance.
 *
 *   SHOT_BASE=http://127.0.0.1:3411 SHOT_OUT=public/help node scripts/shoot-help.mjs
 *
 * Drives the real UI in headless Chrome: signs in as tester and as developer,
 * opens each view, and saves one PNG per step per language. Nothing here is
 * committed except the PNGs it writes into public/help/.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// ESM ignores NODE_PATH; require honours it, so a checkout without its own
// playwright-core can point at one: NODE_PATH=<dir-with-node_modules> node …
const { chromium } = createRequire(import.meta.url)('playwright-core');

const BASE = process.env.SHOT_BASE ?? 'http://127.0.0.1:3411';
const OUT = process.env.SHOT_OUT ?? 'public/help';
mkdirSync(OUT, { recursive: true });

const settle = (p, ms = 350) => p.waitForTimeout(ms);

async function signIn(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('#email', email);
  await page.click('#submit');
  await page.waitForSelector('.langbox', { timeout: 15000 });
  await settle(page);
}

async function setLang(page, lang) {
  await page.click(`.lang[data-lang="${lang}"]`);
  await settle(page);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('shot', name);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

for (const lang of ['vi', 'zh']) {
  // ── tester's side ──
  await signIn(page, 'linh@rgm.example');
  await setLang(page, lang);
  await shot(page, `${lang}-milestones`);

  await page.click('[data-action="view"][data-view="bugs"]');
  await settle(page);
  await shot(page, `${lang}-buglist`);

  // The retest-state bug, as the tester sees it: the verify buttons and the
  // multi-line comment box are the point of this shot — and they live at the
  // bottom of a long page, so scroll the Actions card into view first.
  await page.click('[data-action="openbug"]:has(.st.fixed)');
  await settle(page, 600);
  await page.$eval('#commentnote', (e) => e.scrollIntoView({ block: 'center' }));
  await settle(page);
  await shot(page, `${lang}-bugdetail`);

  await page.click('[data-action="closebug"]');
  await settle(page);
  // The report buttons live on the milestone cards, not in the bug list.
  await page.click('[data-action="view"][data-view="milestones"]');
  await settle(page);
  await page.click('[data-action="report"]');
  await settle(page);
  await shot(page, `${lang}-reportform`);
  await page.click('[data-action="cancelreport"]');
  await settle(page);

  // ── developer's side: the close panel, open on "duplicate" ──
  // A bug in the retest state offers a developer nothing (verification is the
  // tester's), so the close panel is shot on the one being fixed.
  await page.click('[data-action="signout"]');
  await page.waitForSelector('#email', { timeout: 15000 });
  await signIn(page, 'wei@rgm.example');
  await setLang(page, lang);
  await page.click('[data-action="view"][data-view="bugs"]');
  await settle(page);
  await page.click('[data-action="openbug"]:has-text("BUG-2")');
  await settle(page, 600);
  await page.click('[data-action="openclose"][data-kind="duplicate"]');
  await page.waitForSelector('#close-kind');
  // The panel sits at the bottom of a long page; a viewport shot of the top
  // would show a bug detail with no panel in it.
  await page.$eval('#close-kind', (e) => e.scrollIntoView({ block: 'center' }));
  await settle(page);
  await shot(page, `${lang}-closepanel`);
  await page.click('[data-action="cancelclose"]');
  await settle(page);

  await page.click('[data-action="closebug"]');
  await settle(page);
  await page.click('[data-action="view"][data-view="team"]');
  await settle(page);
  await shot(page, `${lang}-team`);
  await page.click('[data-action="signout"]');
  await page.waitForSelector('#email', { timeout: 15000 });
}

// The login page itself, in each language the help pages ship in (it paints its
// own copy on load). English needs no help page, so no English shot.
for (const [lang, locale] of [['vi', 'vi-VN'], ['zh', 'zh-HK']]) {
  const ctx = await browser.newContext({ locale, viewport: { width: 900, height: 620 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await settle(p);
  await p.screenshot({ path: `${OUT}/${lang}-login.png` });
  console.log('shot', `${lang}-login`);
  await ctx.close();
}

await browser.close();
console.log('done');
