// Phase 1 acceptance gate: each workspace tab should be a top-level page
// target (type: "page") in Playwright's CDP enumeration, with target count
// changing as tabs open and close. Run after sign-in.
//
// Usage: AIIDE_CDP_PORT=9222 node scripts/phase1-gate-check.mjs

import { chromium } from 'playwright-core';

const CDP_PORT = process.env.AIIDE_CDP_PORT ?? '9222';

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0];
const shell = ctx.pages().find((p) => p.url().startsWith('http://127.0.0.1:3000'));
if (!shell) {
  console.error('No workspace shell page. Run scripts/playwright-signin.mjs first.');
  await browser.close();
  process.exit(2);
}

const baselineCount = ctx.pages().length;
console.log(`Baseline page count: ${baselineCount}`);
for (const p of ctx.pages()) console.log(`  ${p.url()}`);

// Drive the renderer to open three test URLs through the workspace's
// WorkspaceTabContext.openTab. We don't have a typed handle to the context
// directly — instead we wait for the SSE backend to be unreachable (no
// open_tab events arriving) and inject via a small DOM script that
// patches into the global. Simpler: dispatch synthetic events that the
// shell's existing handleOpenTab listens for? Cleaner: use the React
// devtools internals? Cleanest: expose a small test hook from the shell.
//
// For now, simulate a user opening tabs by calling __AIIDE__-style IPCs
// directly — that bypasses the renderer's persistence layer and just
// proves the WebContentsView path works for each new tab.

const TEST_TABS = [
  { id: 'gate-test-1', url: 'https://example.com/' },
  { id: 'gate-test-2', url: 'https://www.iana.org/' },
];

console.log('\nOpening test tabs via __AIIDE__.tab.open …');
await shell.evaluate(async (tabs) => {
  for (const t of tabs) {
    await window.__AIIDE__.tab.open(t.id, t.url);
  }
}, TEST_TABS);

// Make the last one visible + give it the editor body's rect so it actually
// loads at a non-zero size.
await shell.evaluate(async (tabId) => {
  const body = document.querySelector('.editor-body');
  const r = body.getBoundingClientRect();
  await window.__AIIDE__.tab.setBounds(tabId, {
    x: r.left, y: r.top, width: r.width, height: r.height,
  });
  await window.__AIIDE__.tab.setVisible(tabId, true);
}, TEST_TABS[TEST_TABS.length - 1].id);

await sleep(4000);

const afterOpen = ctx.pages();
console.log(`\nAfter opening ${TEST_TABS.length} tabs (count ${afterOpen.length}):`);
for (const p of afterOpen) console.log(`  ${p.url()}`);

const gainedTabTargets = afterOpen.length - baselineCount;
const gatePassed = gainedTabTargets === TEST_TABS.length;
console.log(
  `\nDelta: +${gainedTabTargets} page target${gainedTabTargets === 1 ? '' : 's'}` +
  ` (expected +${TEST_TABS.length})`
);

console.log('\nClosing test tabs …');
await shell.evaluate(async (tabs) => {
  for (const t of tabs) await window.__AIIDE__.tab.close(t.id);
}, TEST_TABS);

await sleep(1500);
const afterClose = ctx.pages();
console.log(`After close, count = ${afterClose.length} (expected ${baselineCount})`);

await browser.close();

console.log('\n────────────────────────────────────────');
console.log(`PHASE 1 GATE: ${gatePassed && afterClose.length === baselineCount ? 'PASS ✓' : 'FAIL ✗'}`);
console.log('────────────────────────────────────────');

process.exit(gatePassed && afterClose.length === baselineCount ? 0 : 1);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
