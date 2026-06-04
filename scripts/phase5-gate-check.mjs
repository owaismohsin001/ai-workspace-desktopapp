// Phase 5 acceptance gate: bidirectional tab-lifecycle sync.
//
// Asserts that "what the UI thinks is open + active" and "what main / CDP
// think is open + active" stay aligned across:
//   1. The renderer's editor-tab DOM (data-tab-id + data-active attrs)
//   2. Main's `__AIIDE__.tab.list()` registry + activeTabId
//   3. Playwright CDP's enumerated page targets (via __tabId)
//
// And that the alignment survives:
//   • Opening a tab from the renderer side
//   • Switching the active tab from the renderer side
//   • Closing a tab from the renderer side
//
// Usage: AIIDE_CDP_PORT=9222 node scripts/phase5-gate-check.mjs

import { chromium } from 'playwright-core';

const CDP_PORT = process.env.AIIDE_CDP_PORT ?? '9222';
const TEST_TAB_ID = `phase5-test-${Date.now()}`;
const TEST_URL = 'https://example.com/';

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0];

let shell = null;
for (const p of ctx.pages()) {
  try {
    if (await p.evaluate(() => typeof window.__AIIDE__ !== 'undefined')) { shell = p; break; }
  } catch {}
}
if (!shell) { console.error('No workspace shell. Sign in first.'); await browser.close(); process.exit(2); }

console.log(`Shell: ${shell.url()}`);

let passed = 0, failed = 0;
const pass = (m) => { console.log(`  ✓ ${m}`); passed++; };
const fail = (m) => { console.error(`  ✗ ${m}`); failed++; };

/* ── 1. Baseline three-way alignment ──────────────────────────────────── */

console.log('\n[1] Baseline alignment (UI ↔ main ↔ CDP):');
{
  const view = await captureThreeWayView();
  const issues = compareViews(view);
  if (issues.length === 0) pass(`all three views agree on ${view.tabIdsInRenderer.size} tabs`);
  else for (const issue of issues) fail(issue);
  if (view.mainActive && view.rendererActive && view.mainActive === view.rendererActive) {
    pass(`active tab agrees: ${view.mainActive}`);
  } else {
    fail(`active tab mismatch — renderer=${view.rendererActive ?? '(none)'} main=${view.mainActive ?? '(none)'}`);
  }
}

/* ── 2. Open from renderer side ───────────────────────────────────────── */

console.log('\n[2] Open from renderer side:');
const beforeOpen = await captureThreeWayView();
await shell.evaluate(async ({ tabId, url }) => {
  await window.__AIIDE__.tab.open(tabId, url);
  const body = document.querySelector('.editor-body');
  if (body) {
    const r = body.getBoundingClientRect();
    await window.__AIIDE__.tab.setBounds(tabId, { x: r.left, y: r.top, width: r.width, height: r.height });
  }
}, { tabId: TEST_TAB_ID, url: TEST_URL });

const afterOpen = await waitForView((v) =>
  v.mainTabIds.has(TEST_TAB_ID) && v.cdpTabIds.has(TEST_TAB_ID), 8000);

if (!afterOpen) {
  fail(`new tab ${TEST_TAB_ID} not reflected in main + CDP after open`);
} else {
  pass(`new tab ${TEST_TAB_ID} visible to main (registry)`);
  pass(`new tab ${TEST_TAB_ID} visible to CDP (page target)`);
  if (afterOpen.mainTabIds.size === beforeOpen.mainTabIds.size + 1) {
    pass(`main registry grew by 1 (${beforeOpen.mainTabIds.size} → ${afterOpen.mainTabIds.size})`);
  } else {
    fail(`unexpected main registry delta: ${beforeOpen.mainTabIds.size} → ${afterOpen.mainTabIds.size}`);
  }
}

/* ── 3. Active switch from renderer side ──────────────────────────────── */
// Use one of the user's existing tabs as a fresh "active" target. We pick
// whichever tab the renderer reports first that isn't the test tab.

console.log('\n[3] Active-tab switch (renderer drives main):');
const targetActiveTabId = afterOpen
  ? [...afterOpen.tabIdsInRenderer].find((id) => id !== afterOpen.rendererActive && id !== TEST_TAB_ID)
  : null;
if (!targetActiveTabId) {
  fail('no spare tab in renderer to switch to');
} else {
  // The renderer's onSelectTab handler runs `setActiveTabId` directly, which
  // is what fires the setActive useEffect. We drive that path by clicking
  // the matching tab strip element.
  await shell.evaluate((tabId) => {
    const el = document.querySelector(`[data-tab-id="${tabId}"]`);
    if (el && el instanceof HTMLElement) el.click();
  }, targetActiveTabId);

  const afterSwitch = await waitForView((v) =>
    v.mainActive === targetActiveTabId && v.rendererActive === targetActiveTabId, 4000);

  if (!afterSwitch) {
    const v = await captureThreeWayView();
    fail(`active switch didn't propagate — renderer=${v.rendererActive ?? '(none)'} main=${v.mainActive ?? '(none)'} expected=${targetActiveTabId}`);
  } else {
    pass(`renderer + main both see active = ${targetActiveTabId}`);
  }
}

/* ── 4. Close test tab from renderer side ─────────────────────────────── */

console.log('\n[4] Close from renderer side:');
await shell.evaluate(async (tabId) => {
  await window.__AIIDE__.tab.close(tabId);
}, TEST_TAB_ID);

const afterClose = await waitForView((v) =>
  !v.mainTabIds.has(TEST_TAB_ID) && !v.cdpTabIds.has(TEST_TAB_ID), 4000);

if (!afterClose) {
  fail(`test tab ${TEST_TAB_ID} did not disappear from main + CDP after close`);
} else {
  pass(`main + CDP both dropped test tab`);
}

/* ── Cleanup + report ────────────────────────────────────────────────── */

await browser.close();

console.log('\n────────────────────────────────────────');
console.log(`PHASE 5 GATE: ${failed === 0 ? `PASS ✓ (${passed} checks)` : `FAIL ✗ (${passed} passed, ${failed} failed)`}`);
console.log('────────────────────────────────────────');
process.exit(failed === 0 ? 0 : 1);

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * Snapshot UI / main / CDP all at the same moment.
 * Renderer view = the DOM tab strip's data-tab-id / data-active attrs.
 * Main view = __AIIDE__.tab.list() — registry + activeTabId.
 * CDP view = pages with a __tabId.
 */
async function captureThreeWayView() {
  const rendererState = await shell.evaluate(() => {
    const strip = Array.from(document.querySelectorAll('[data-tab-id]'));
    return {
      tabIdsInRenderer: strip.map((el) => el.getAttribute('data-tab-id')),
      rendererActive:
        strip.find((el) => el.hasAttribute('data-active'))?.getAttribute('data-tab-id') ?? null,
    };
  });

  const mainState = await shell.evaluate(() => window.__AIIDE__.tab.list());

  const cdpTabIds = new Set();
  for (const p of ctx.pages()) {
    try {
      const tid = await p.evaluate(() => window.__tabId ?? null);
      if (tid) cdpTabIds.add(tid);
    } catch {}
  }

  return {
    tabIdsInRenderer: new Set(rendererState.tabIdsInRenderer),
    rendererActive: rendererState.rendererActive,
    mainTabIds: new Set(mainState.tabs.map((t) => t.tabId)),
    mainActive: mainState.activeTabId,
    cdpTabIds,
  };
}

function compareViews(v) {
  const issues = [];
  // Renderer DOM may include tabs without a WebContentsView (empty "new
  // tab" pages with no URL). So we only assert: every tab the renderer
  // BELIEVES has a view (those whose tabId appears in main's registry)
  // should ALSO be a CDP page target.
  for (const tabId of v.mainTabIds) {
    if (!v.cdpTabIds.has(tabId)) issues.push(`main registry has ${tabId} but no CDP page target`);
  }
  for (const tabId of v.cdpTabIds) {
    if (!v.mainTabIds.has(tabId)) issues.push(`CDP page target has __tabId=${tabId} but main has no registry entry`);
  }
  // Tabs with views must also be in the renderer's tab strip.
  for (const tabId of v.mainTabIds) {
    if (!v.tabIdsInRenderer.has(tabId)) issues.push(`main has ${tabId} but renderer tab strip doesn't include it`);
  }
  return issues;
}

async function waitForView(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await captureThreeWayView();
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
