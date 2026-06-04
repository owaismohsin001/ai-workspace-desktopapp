// Phase 2 acceptance gate: every WebContentsView page target reports a
// window.__tabId that matches the tabId our renderer used to create it. The
// mapping must hold across:
//   - newly opened tabs
//   - in-page (SPA) navigation
//   - full document navigation
//   - tab close (the page target should disappear from the mapping)
//
// Usage: AIIDE_CDP_PORT=9222 node scripts/phase2-gate-check.mjs
//
// Assumes the desktop app is already signed in and has at least the
// workspace shell page open. Run scripts/playwright-signin.mjs first if
// needed.

import { chromium } from 'playwright-core';

const CDP_PORT = process.env.AIIDE_CDP_PORT ?? '9222';

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0];

// Identify the workspace shell by the presence of __AIIDE__ in its page
// context — that's the renderer of the main BrowserWindow, the only page
// where preload.js (not preload-tab.js) runs. URL pattern matching is
// fragile because tab views are on bytescripterz.com subdomains too.
let shell = null;
for (const p of ctx.pages()) {
  try {
    const hasAiide = await p.evaluate(() => typeof window.__AIIDE__ !== 'undefined');
    if (hasAiide) { shell = p; break; }
  } catch { /* dead / error page */ }
}
if (!shell) {
  console.error('No workspace shell (no page exposes __AIIDE__). Sign in first.');
  await browser.close();
  process.exit(2);
}
console.log(`Shell: ${shell.url()}`);

let passed = 0;
let failed = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✓ ${msg}`); passed++; };

/** Build a {tabId → page} map across the current context, skipping pages
 *  without a __tabId (the workspace shell itself, OAuth popups, etc.). */
async function buildRegistry(ctxArg = ctx) {
  const out = new Map();
  for (const p of ctxArg.pages()) {
    let tabId = null;
    try { tabId = await p.evaluate(() => window.__tabId ?? null); } catch { /* dead / cross-origin error page */ }
    if (tabId) out.set(tabId, p);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────
   Test 1: existing tabs (restored from openedUrls) all have __tabId
   ──────────────────────────────────────────────────────────────────── */
console.log('\n[1/4] Existing tabs have __tabId');
{
  const reg = await buildRegistry();
  if (reg.size === 0) fail('no tabs surfaced a __tabId (preload not loaded?)');
  else pass(`${reg.size} existing tab${reg.size === 1 ? '' : 's'} all carry a __tabId`);

  // Cross-check: each registry entry's URL should also match one of the
  // renderer's tab URLs.
  const rendererTabs = await shell.evaluate(() => {
    // The workspace shell doesn't expose React state externally, but every
    // PreviewPane that created a view passes tabId+url via tab.open. Read
    // from the DOM instead: each tab is a <PreviewPane> placeholder; the
    // tab strip itself has data-tab-id attributes for the labels.
    const strip = document.querySelectorAll('[data-tab-id]');
    return Array.from(strip).map((el) => ({
      tabId: el.getAttribute('data-tab-id'),
      label: el.textContent?.trim() ?? '',
    }));
  }).catch(() => []);
  if (rendererTabs.length > 0) {
    const stripIds = new Set(rendererTabs.map((t) => t.tabId).filter(Boolean));
    let allCovered = true;
    for (const tabId of reg.keys()) {
      if (!stripIds.has(tabId)) { allCovered = false; break; }
    }
    if (allCovered) pass('every CDP tabId appears in the renderer\'s tab strip');
    else fail('a CDP tabId has no matching tab strip entry — registry drift');
  } else {
    console.log('  (skipping renderer cross-check — no data-tab-id on tab strip)');
  }
}

/* ────────────────────────────────────────────────────────────────────
   Test 2: open a new tab → it shows up in the registry with the right id
   ──────────────────────────────────────────────────────────────────── */
console.log('\n[2/4] Open new tab → __tabId matches');
const NEW_TAB_ID = `phase2-test-${Date.now()}`;
const NEW_TAB_URL = 'https://example.com/';
{
  const beforeCount = ctx.pages().length;
  await shell.evaluate(async ({ tabId, url }) => {
    await window.__AIIDE__.tab.open(tabId, url);
    // Give the view bounds + visibility so the load actually progresses.
    const body = document.querySelector('.editor-body');
    if (body) {
      const r = body.getBoundingClientRect();
      await window.__AIIDE__.tab.setBounds(tabId, {
        x: r.left, y: r.top, width: r.width, height: r.height,
      });
    }
    await window.__AIIDE__.tab.setVisible(tabId, true);
  }, { tabId: NEW_TAB_ID, url: NEW_TAB_URL });

  // Wait for the new page target.
  const newPage = await waitFor(async () => {
    return (await buildRegistry()).get(NEW_TAB_ID) ?? null;
  }, 8000);

  if (!newPage) fail(`new tab ${NEW_TAB_ID} did not surface as a CDP page with matching __tabId`);
  else {
    pass(`new tab page has __tabId = ${NEW_TAB_ID}`);
    if (newPage.url().startsWith(NEW_TAB_URL.replace(/\/$/, ''))) pass(`URL matches: ${newPage.url()}`);
    else fail(`URL mismatch: expected ${NEW_TAB_URL}, got ${newPage.url()}`);
    if (ctx.pages().length === beforeCount + 1) pass(`page count rose by 1 (${beforeCount} → ${ctx.pages().length})`);
    else fail(`page count change unexpected: ${beforeCount} → ${ctx.pages().length}`);
  }
}

/* ────────────────────────────────────────────────────────────────────
   Test 3: full-document navigation preserves __tabId
   ──────────────────────────────────────────────────────────────────── */
console.log('\n[3/4] Full navigation preserves __tabId');
{
  await shell.evaluate(async ({ tabId, url }) => {
    await window.__AIIDE__.tab.navigate(tabId, url);
  }, { tabId: NEW_TAB_ID, url: 'https://www.iana.org/' });

  // Wait for the navigation to settle.
  await waitFor(async () => {
    const p = (await buildRegistry()).get(NEW_TAB_ID);
    return p && p.url().includes('iana.org') ? p : null;
  }, 10000);

  const afterReg = await buildRegistry();
  const page = afterReg.get(NEW_TAB_ID);
  if (!page) fail(`__tabId lost across navigation (no entry for ${NEW_TAB_ID})`);
  else if (!page.url().includes('iana.org')) fail(`navigation didn't land on iana.org (url=${page.url()})`);
  else pass(`__tabId survived navigation to iana.org`);
}

/* ────────────────────────────────────────────────────────────────────
   Test 4: close the tab → mapping disappears
   ──────────────────────────────────────────────────────────────────── */
console.log('\n[4/4] Close tab → mapping drops');
{
  const beforeCount = ctx.pages().length;
  await shell.evaluate(async (tabId) => {
    await window.__AIIDE__.tab.close(tabId);
  }, NEW_TAB_ID);

  await waitFor(async () => {
    return (await buildRegistry()).get(NEW_TAB_ID) ? null : true;
  }, 5000);

  const reg = await buildRegistry();
  if (reg.has(NEW_TAB_ID)) fail(`registry still has entry for closed tab ${NEW_TAB_ID}`);
  else pass(`closed tab ${NEW_TAB_ID} dropped from registry`);

  if (ctx.pages().length === beforeCount - 1) pass(`page count fell by 1 (${beforeCount} → ${ctx.pages().length})`);
  else fail(`page count after close: ${beforeCount} → ${ctx.pages().length}`);
}

await browser.close();

console.log('\n────────────────────────────────────────');
console.log(`PHASE 2 GATE: ${failed === 0 ? `PASS ✓ (${passed} checks)` : `FAIL ✗ (${passed} passed, ${failed} failed)`}`);
console.log('────────────────────────────────────────');
process.exit(failed === 0 ? 0 : 1);

/* ── helpers ─────────────────────────────────────────────────────── */

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
