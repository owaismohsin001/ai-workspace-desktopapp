// Phase 3 acceptance gate. With AIIDE_CDP_PORT + AIIDE_MCP_PORT both set,
// the desktop app exposes:
//   - a Chromium CDP endpoint   on AIIDE_CDP_PORT (loopback)
//   - a Playwright MCP endpoint on AIIDE_MCP_PORT (loopback, HTTP/SSE)
//
// This gate:
//   1. Opens a clean test tab via __AIIDE__.tab.open over CDP (known path).
//   2. Connects an MCP client to the MCP endpoint.
//   3. Confirms browser_tabs / browser_snapshot / browser_click are exposed.
//   4. browser_tabs list                → our test tab is in there.
//   5. browser_tabs select              → switches Playwright MCP's active page.
//   6. browser_snapshot                 → ARIA snapshot contains the page content.
//   7. browser_click (using a ref from the snapshot) → page navigates.
//   8. Cleanup: close the test tab.
//
// Usage: AIIDE_CDP_PORT=9222 AIIDE_MCP_PORT=9090 node scripts/phase3-gate-check.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from 'playwright-core';

const CDP_PORT = process.env.AIIDE_CDP_PORT ?? '9222';
const MCP_PORT = process.env.AIIDE_MCP_PORT ?? '9090';
const TEST_TAB_ID = `phase3-test-${Date.now()}`;
const TEST_URL = 'https://example.com/';

let passed = 0, failed = 0;
const pass = (m) => { console.log(`  ✓ ${m}`); passed++; };
const fail = (m) => { console.error(`  ✗ ${m}`); failed++; };

/* ────────────────────────────────────────────────────────────────────
   Setup — Playwright-over-CDP for our control plane (open/close tabs)
   ──────────────────────────────────────────────────────────────────── */

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0];

let shell = null;
for (const p of ctx.pages()) {
  try {
    if (await p.evaluate(() => typeof window.__AIIDE__ !== 'undefined')) { shell = p; break; }
  } catch { /* not the shell */ }
}
if (!shell) {
  console.error('No workspace shell. Sign in first.');
  await browser.close();
  process.exit(2);
}

console.log(`Shell: ${shell.url()}`);
console.log(`Test tab: ${TEST_TAB_ID} → ${TEST_URL}`);

await shell.evaluate(async ({ tabId, url }) => {
  await window.__AIIDE__.tab.open(tabId, url);
  const body = document.querySelector('.editor-body');
  if (body) {
    const r = body.getBoundingClientRect();
    await window.__AIIDE__.tab.setBounds(tabId, { x: r.left, y: r.top, width: r.width, height: r.height });
  }
  await window.__AIIDE__.tab.setVisible(tabId, true);
}, { tabId: TEST_TAB_ID, url: TEST_URL });

// Wait for the new view to appear as a CDP page + load.
await waitFor(async () => {
  for (const p of ctx.pages()) {
    try {
      const tid = await p.evaluate(() => window.__tabId ?? null);
      if (tid === TEST_TAB_ID) {
        // Also wait for the page to have actually loaded so the snapshot has content.
        await p.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
        return p;
      }
    } catch { /* not the tab */ }
  }
  return null;
}, 10000);

/* ────────────────────────────────────────────────────────────────────
   MCP client
   ──────────────────────────────────────────────────────────────────── */

const mcpClient = new Client({ name: 'phase3-gate-check', version: '0.0.1' }, {});
const mcpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/`));
await mcpClient.connect(mcpTransport);
pass(`MCP client connected to http://127.0.0.1:${MCP_PORT}/`);

const toolList = await mcpClient.listTools();
const toolNames = new Set(toolList.tools.map((t) => t.name));
for (const req of ['browser_tabs', 'browser_snapshot', 'browser_click']) {
  if (toolNames.has(req)) pass(`tool exposed: ${req}`);
  else fail(`tool missing: ${req}`);
}
console.log(`  (total tools exposed: ${toolList.tools.length})`);

/* ────────────────────────────────────────────────────────────────────
   browser_tabs list
   ──────────────────────────────────────────────────────────────────── */

console.log('\nbrowser_tabs list:');
const tabsRes = await mcpClient.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
const tabsText = mergeTextOutput(tabsRes);
if (tabsText.includes(TEST_URL.replace(/\/$/, '')) || tabsText.includes('example.com')) {
  pass(`test tab visible in browser_tabs output`);
} else {
  fail(`test tab not in browser_tabs output (got: ${tabsText.slice(0, 200)}…)`);
}

// Parse the tab index from the listing. Playwright MCP returns lines like:
//   - 0: [active] Workspace shell - https://…
//   - 1: Example Domain - https://example.com/
const tabIndex = findTabIndex(tabsText, TEST_URL);
if (tabIndex >= 0) pass(`found test tab at index ${tabIndex}`);
else fail('could not parse a tab index from browser_tabs output');

/* ────────────────────────────────────────────────────────────────────
   browser_tabs select → browser_snapshot
   ──────────────────────────────────────────────────────────────────── */

if (tabIndex >= 0) {
  console.log('\nbrowser_tabs select → browser_snapshot:');
  await mcpClient.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: tabIndex } });
  pass(`selected tab ${tabIndex}`);

  const snapRes = await mcpClient.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapText = mergeTextOutput(snapRes);
  if (snapText.toLowerCase().includes('example domain')) pass('snapshot contains "Example Domain"');
  else fail('snapshot missing expected content (got: ' + snapText.slice(0, 200) + '…)');

  // Find the outbound link on example.com. The page wording has changed
  // historically ("More information…" → "Learn more"), so accept either
  // — it's the only top-level link out to iana.org.
  const linkRef = findElementRef(snapText, /^\s*-\s*link "(learn more|more information)/i);
  if (!linkRef) {
    fail('could not locate the example.com outbound link ref in snapshot');
    console.error('  --- snapshot excerpt (first 1500 chars): ---');
    console.error(snapText.slice(0, 1500).split('\n').map((l) => '    ' + l).join('\n'));
    console.error('  --- end snapshot excerpt ---');
  } else {
    pass(`found outbound link ref: ${linkRef}`);

    /* ──────────────────────────────────────────────────────────────
       browser_click
       ────────────────────────────────────────────────────────────── */

    console.log('\nbrowser_click:');
    try {
      await mcpClient.callTool({
        name: 'browser_click',
        arguments: { element: '"More information…" link on example.com', target: linkRef },
      });
      pass('browser_click returned without error');

      // Verify navigation occurred by re-snapshotting.
      await new Promise((r) => setTimeout(r, 1500));
      const snap2 = mergeTextOutput(await mcpClient.callTool({ name: 'browser_snapshot', arguments: {} }));
      const navigated = !snap2.toLowerCase().includes('illustrative example') && snap2.length > 100;
      // example.com's "More information" → iana.org/help/example-domains
      if (snap2.toLowerCase().includes('iana') || snap2.toLowerCase().includes('reserved')) pass('navigation landed on iana.org (post-click snapshot has iana content)');
      else if (navigated) pass('post-click snapshot differs from initial — page navigated');
      else fail('post-click page does not look navigated');
    } catch (err) {
      fail(`browser_click threw: ${err.message ?? err}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────
   Cleanup
   ──────────────────────────────────────────────────────────────────── */

await shell.evaluate(async (tabId) => {
  await window.__AIIDE__.tab.close(tabId);
}, TEST_TAB_ID);

await mcpClient.close();
await browser.close();

console.log('\n────────────────────────────────────────');
console.log(`PHASE 3 GATE: ${failed === 0 ? `PASS ✓ (${passed} checks)` : `FAIL ✗ (${passed} passed, ${failed} failed)`}`);
console.log('────────────────────────────────────────');
process.exit(failed === 0 ? 0 : 1);

/* ── helpers ─────────────────────────────────────────────────────── */

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function mergeTextOutput(toolResult) {
  if (!toolResult?.content) return '';
  return toolResult.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function findTabIndex(listing, urlPrefix) {
  const lines = listing.split('\n');
  for (const line of lines) {
    const idxMatch = line.match(/-\s*(\d+)\s*:/);
    if (idxMatch && line.includes('example.com')) return Number(idxMatch[1]);
  }
  return -1;
}

function findElementRef(snapshot, textMatcher) {
  // Snapshot lines vary by Playwright MCP version. Observed shapes:
  //   - link "More information..." [ref=e23] /url: https://…
  //   - link "More information..." [ref=e23]:        (ref then colon)
  //   - link "More information..." /url: https://… [ref=e23]
  //   - generic [ref=e1]:                            (ref without text on next lines)
  // Walk each line looking for both the text match and a [ref=…] token. If
  // the text-match line itself has no ref, look at neighboring lines.
  const lines = snapshot.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!textMatcher.test(lines[i])) continue;
    for (let j = i; j < Math.min(lines.length, i + 3); j++) {
      const m = lines[j].match(/\[ref=([^\]\s]+)\]/);
      if (m) return m[1];
    }
  }
  return null;
}
