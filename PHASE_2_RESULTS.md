# Phase 2 results — tab registry & CDP target correlation

**Outcome: gate PASSED (7/7 checks).** Every `WebContentsView` page target
now carries `window.__tabId`, so a Playwright client can map any CDP `Page`
back to the renderer's `tabId` with a single `page.evaluate`. The marker
survives full navigation and is correctly removed when a tab closes.

Verified 2026-06-05 against the live EC2 workspace
(`umarinfo002@gmail.com`, 6 persisted tabs) via
[scripts/phase2-gate-check.mjs](scripts/phase2-gate-check.mjs).

---

## 2.1 What ships

- **New: [preload-tab.js](preload-tab.js)** — single preload reused by every
  view. Reads the per-tab id from `process.argv` (`--ai-ide-tab-id=<id>`,
  injected by main via `webPreferences.additionalArguments`) and exposes
  it as `window.__tabId` via `contextBridge.exposeInMainWorld`.
- **[tab-manager.js](tab-manager.js)** — every `WebContentsView` created in
  `TabManager._open` now passes `preload` + `additionalArguments` so the
  marker is wired automatically. No code path creates an unmarked view.
- **[package.json](package.json)** — `build.files` includes `preload-tab.js`
  so `electron-builder` ships it.
- **New: [scripts/phase2-gate-check.mjs](scripts/phase2-gate-check.mjs)** —
  drives the four-test acceptance gate (see §2.2).

No renderer-side changes. The whole correlation surface lives in the
desktop app — **no EC2 deploy needed** for Phase 2.

---

## 2.2 Acceptance-gate output

```
Shell: https://frontend-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/

[1/4] Existing tabs have __tabId
  ✓ 6 existing tabs all carry a __tabId

[2/4] Open new tab → __tabId matches
  ✓ new tab page has __tabId = phase2-test-1780607717961
  ✓ URL matches: https://example.com/
  ✓ page count rose by 1 (7 → 8)

[3/4] Full navigation preserves __tabId
  ✓ __tabId survived navigation to iana.org

[4/4] Close tab → mapping drops
  ✓ closed tab phase2-test-1780607717961 dropped from registry
  ✓ page count fell by 1 (8 → 7)

PHASE 2 GATE: PASS ✓ (7 checks)
```

Each check validates a different invariant Phase 3 (Playwright MCP)
depends on:
1. Existing tabs are correlatable on cold connection (no setup IPC needed)
2. Newly opened tabs get marked synchronously enough that a tight
   open-then-evaluate loop works
3. The marker is **automatically re-injected** on full document load —
   the preload runs once per document, no `did-navigate` handler in main
4. Close drops the page target and therefore the mapping; no stale entries

---

## 2.3 Design notes

### Why preload + `additionalArguments` instead of `executeJavaScript`

The plan's first-pass suggestion was to inject `window.__tabId` via
`view.webContents.executeJavaScript` and re-inject on `did-navigate`. That
works but has two real costs:

- **Race**: `did-navigate` fires after the new document has started parsing.
  Any page script that reads `window.__tabId` early — including
  intentionally adversarial reads — sees `undefined` until our injection
  lands. A user-mode preload (which runs *before* page scripts) avoids
  this entirely.
- **CDP-debugger contention**: `executeJavaScript` uses Electron's debugger
  channel. Phase 3 will have Playwright MCP attached to each view via CDP
  for everything else (clicks, snapshots, network). Two CDP clients on the
  same target conflict, so we'd be racing ourselves.

`additionalArguments` is the only mechanism that gets a runtime value into
a preload without an extra IPC handshake or hard-coded ENV. We pass a
single CLI-style argument; the preload reads it from `process.argv`.

### Why `contextBridge.exposeInMainWorld` instead of patching `window` directly

The preload runs with `contextIsolation: true` (we keep that — same as
the rest of the app, security baseline). In that mode, `window` inside
the preload is a different object than `window` inside the page. The
contextBridge is the supported way to surface a value across the boundary
that page scripts can read directly (`window.__tabId`).

### Failure mode: marker already set

If something *else* sets `window.__tabId` before our preload runs (it
can't, but defensive code is cheap), `exposeInMainWorld` throws. We
swallow that — fail open. The existing value stays. In practice this only
matters if a page deliberately defines `__tabId` itself; we accept that
collision rather than overwrite, because tooling that relies on the marker
should still be able to detect mismatch by also checking against the
TabManager's known set.

---

## 2.4 Carry-overs / known issues

- **[scripts/phase2-gate-check.mjs](scripts/phase2-gate-check.mjs) skips a
  cross-check.** The "renderer's tab strip has data-tab-id attributes"
  test prints `(skipping renderer cross-check — no data-tab-id on tab strip)`
  because [editor-tabs.tsx](../AIWorkspaceFrontEnd/src/components/workspace/editor-tabs.tsx)
  doesn't currently set `data-tab-id` on the tab buttons. The other 7
  checks cover correlation; adding the attribute would just give the
  gate a redundant DOM-side confirmation. Not blocking.
- **Renderer doesn't read `window.__tabId`.** It's purely consumed by
  external Playwright / MCP clients. If we ever want the renderer's tab
  state to flow back from a page (e.g. "this tab navigated, update the
  label"), we'd add a separate `tab:url-change` handler — which we already
  have, from Phase 1.

---

## 2.5 How to reproduce

```powershell
# 1. App running with CDP enabled (signed in)
cd d:\ai-project\ai-workspace-desktopapp
$env:AIIDE_CDP_PORT = "9222"; npm start

# 2. Run the gate
node scripts/phase2-gate-check.mjs
```

Expected last line: `PHASE 2 GATE: PASS ✓ (7 checks)`.
