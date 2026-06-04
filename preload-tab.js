'use strict';

// Per-WebContentsView preload (Phase 2).
//
// Sole job: stamp `window.__tabId` on the page so a Playwright client
// connected via CDP can map a Page object back to our renderer's tabId by
// calling `await page.evaluate(() => window.__tabId)`. The mapping is what
// every higher-level tool needs ("act on tab X" → look up its Page) without
// opening a competing CDP debugger session against the same target.
//
// The tabId can't be hard-coded in this file because every tab uses the same
// preload — it comes from `webPreferences.additionalArguments` set by the
// TabManager at view creation. The main process passes `--ai-ide-tab-id=<id>`;
// we read it from `process.argv` here.
//
// Re-injection is automatic: Electron re-runs the preload for every new
// document load, so a full navigation gets a fresh `window.__tabId` without
// any did-navigate handler in main. SPA navigations don't re-run the preload
// (same document), but `window.__tabId` was set on the original load and is
// preserved through history pushState / replaceState.

const { contextBridge } = require('electron');

const TAB_ID_PREFIX = '--ai-ide-tab-id=';
const arg = process.argv.find((a) => a.startsWith(TAB_ID_PREFIX));
const tabId = arg ? arg.slice(TAB_ID_PREFIX.length) : null;

if (tabId) {
  try {
    // exposeInMainWorld places the value on the page's window with
    // contextIsolation honored — page scripts and CDP `Runtime.evaluate`
    // both see `window.__tabId === tabId`. Throws if the key already
    // exists, which only happens if something else also injected
    // `window.__tabId` — fail open in that case.
    contextBridge.exposeInMainWorld('__tabId', tabId);
  } catch {
    /* already set — leave the existing value in place */
  }
}
