// Drive the desktop app's connect window via Playwright connectOverCDP and
// sign in by filling the manual workspace-URL form. Saves a click during dev
// iteration; also doubles as a Phase 1 gate check by enumerating all CDP
// page targets after the workspace window opens.
//
// Usage: AIIDE_CDP_PORT=9222 node scripts/playwright-signin.mjs <workspaceUrl>
//        or just: node scripts/playwright-signin.mjs <workspaceUrl>
//
// Hard-codes nothing about a particular workspace — the URL is passed in.

import { chromium } from 'playwright-core';

const CDP_PORT = process.env.AIIDE_CDP_PORT ?? '9222';
const WORKSPACE_URL = process.argv[2];

if (!WORKSPACE_URL) {
  console.error('usage: node scripts/playwright-signin.mjs <workspaceUrl>');
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0];

console.log('PAGES BEFORE SIGN-IN:');
for (const p of ctx.pages()) console.log(`  ${p.url()}`);

const connect = ctx.pages().find((p) => /connect\.html$/i.test(p.url()));
if (!connect) {
  console.error('No connect.html page found. Already signed in?');
  await browser.close();
  process.exit(0);
}

await connect.fill('#workspaceUrl', WORKSPACE_URL);
await connect.click('#manualBtn');

// Wait for the workspace window. The connect window closes; a new page target
// appears whose URL matches workspaceUrl. Poll the context for it.
const target = await waitForPage(ctx, (p) => p.url().startsWith(WORKSPACE_URL), 15000);
if (!target) {
  console.error('Timeout waiting for workspace page to appear after sign-in.');
  await browser.close();
  process.exit(1);
}

// Give the renderer a few seconds to mount tabs (each tab.open IPC creates
// a WebContentsView, which surfaces as a new page target).
await sleep(5000);

console.log('\nPAGES AFTER SIGN-IN + TABS MOUNTED:');
const pages = ctx.pages();
for (const p of pages) {
  console.log(`  type=page  ${p.url()}`);
}
console.log(`\nTOTAL: ${pages.length}  (1 shell + ${pages.length - 1} tab targets)`);

await browser.close();

/* ── helpers ────────────────────────────────────────────────────────── */

async function waitForPage(ctx, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = ctx.pages().find(predicate);
    if (found) return found;
    await sleep(250);
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
