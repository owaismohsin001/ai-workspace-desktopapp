# Phase 1 results — `<iframe>` → `WebContentsView`

**Outcome: gate PASSED.** Each workspace tab is now a top-level page target
addressable by Playwright over CDP. Verified against the live build on
2026-06-05 using the in-repo scripts under [scripts/](scripts/).

This file picks up where [PHASE_0_BASELINE.md](PHASE_0_BASELINE.md) left off.
Read that doc for the migration premise correction (it was actually
`<iframe>` → `WebContentsView`, not `<webview>` → `WebContentsView`) and the
before-state baseline.

---

## 1.1 What ships in Phase 1

### Main process
- **New: [tab-manager.js](tab-manager.js)** — a `TabManager` class owns a
  `Map<tabId, { view, visible, lastBounds }>` and exposes seven IPC handlers
  (`tab:open / close / navigate / reload / setVisible / setBounds /
  capture`). Each `tab:open` creates a `WebContentsView`, which is what
  surfaces as `type: "page"` to CDP. Per-view `setWindowOpenHandler` preserves
  the prior payment/OAuth carve-out (Stripe/PayPal/Google/etc → standalone
  `BrowserWindow`; everything else → workspace tab via the renderer's
  `open-tab` IPC).
- **[main.js](main.js)** — instantiates one `TabManager` for the app
  lifetime, with a lazy `getOwnerWindow()` accessor so the manager survives
  sign-out → reconnect (the prior main window closes, a new one opens,
  `rebindToWindow()` re-attaches every existing view). `destroyAll()` runs
  on `window-all-closed` so we don't leak page targets past shutdown.

### Preload
- **[preload.js](preload.js)** — exposes `window.__AIIDE__.tab.{open, close,
  navigate, reload, setVisible, setBounds, capture, onLoadingChange,
  onTitleChange, onUrlChange}`. The pre-existing `__AIIDE__.onOpenTab`
  (popup→tab routing) is unchanged.

### Renderer (`AIWorkspaceFrontEnd`)
- **New: [src/utils/electronTabs.ts](../AIWorkspaceFrontEnd/src/utils/electronTabs.ts)**
  — typed accessor + `ElectronTabs` interface mirroring the preload API.
  Returns `null` outside Electron, so call-sites branch.
- **[src/components/workspace/preview-pane.tsx](../AIWorkspaceFrontEnd/src/components/workspace/preview-pane.tsx)**
  — branches on `getElectronTabs()`:
  - Electron mode: manages tab lifecycle via IPC (`open` on mount,
    `navigate` on URL change, `setVisible` on `(isActive && !snapshot)`
    flips, `close` on unmount). No `<iframe>` rendered — the
    `WebContentsView` is composited above the renderer. DOM overlays
    (snapshot `<img>`, drawing surface, comments surface, annotations
    `<svg>`) still render in the same `.preview-content` div.
  - Browser fallback: renders `<iframe>` the legacy way. Keeps `npm run dev`
    working outside Electron.
  - The `onElementsReady` callback now reports `{ contentEl, svg }` instead
    of `{ iframe, svg }`. The `contentEl` is whichever DOM element has the
    on-screen rect — iframe in browser, `.preview-content` div in Electron.
- **[src/components/workspace/workspace-shell.tsx](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx)**
  — three changes:
  1. **Reload:** `handleActiveTabReload` calls `electron.reload(activeTabId)`
     in Electron mode. Browser fallback keeps the about:blank bounce trick.
  2. **Loading state:** subscribes to `electron.onLoadingChange` and routes
     into `handleTabLoadingChange`. The per-iframe `onLoad` is bypassed in
     Electron mode (it would never fire — no DOM iframe).
  3. **Bounds contract:** a `ResizeObserver` on `.editor-body` (plus a
     `window.resize` listener for good measure) reports the rect to
     `electron.setBounds(activeTabId, rect)` on every layout change, rAF-
     throttled. Re-fires on `activeTabId`, `chatWidth`, and
     `toolbarVisible` changes to catch:
     - chat-panel drag-resize (lives behind the existing `chatWidth` state)
     - chat-panel double-click reset
     - editor-overlay-toolbar collapse/expand (changes editor-body height)
     - window resize / OS DPI changes (captured by `ResizeObserver`)
  4. `iframeRefs` map renamed to `contentRefs` (typed as `HTMLElement | null`).
- **[src/utils/captureIframeSnapshot.ts](../AIWorkspaceFrontEnd/src/utils/captureIframeSnapshot.ts)**
  — `captureIframeSnapshot` renamed to `captureTabSnapshot`. In Electron
  mode it calls `electron.capture(tabId)` which returns a PNG data URL from
  `webContents.capturePage()`. No `getDisplayMedia` permission prompt, no
  devicePixelRatio crop math. Browser fallback unchanged.

### Sign-in & gate-check tooling
- **New: [scripts/playwright-signin.mjs](scripts/playwright-signin.mjs)** —
  `connectOverCDP` against `AIIDE_CDP_PORT`, drives the connect window's
  manual URL form. Per session memory: this is now the default sign-in
  path instead of a manual click-through.
- **New: [scripts/phase1-gate-check.mjs](scripts/phase1-gate-check.mjs)** —
  opens N test tabs via the renderer's `__AIIDE__.tab.open`, verifies the
  page count rises by N, closes them, verifies it returns to baseline.
  Used as the acceptance gate below.
- `playwright-core` added to `devDependencies` so the scripts are runnable
  out of the box.

### Dead-code removed
All five items flagged in §0.1 of the baseline doc:
- `webPreferences.webviewTag: true` on the main window — removed.
- `will-attach-webview` handler and the `preload-webview.js` injection —
  removed.
- `app.on('web-contents-created')` webview-type branch in `setWindowOpenHandler`
  — removed.
- `webview-popup-open` IPC handler in `main.js` — removed.
- `preload-webview.js` file — deleted (also removed from `build.files` in
  `package.json`).

---

## 1.2 Acceptance-gate output

The original Phase 0 plan stated the gate as: re-running `/json/list` with
multiple tabs should show **one `type: "page"` per workspace tab** in
addition to the shell renderer.

### Before (Phase 0 baseline, re-stated for contrast)

| Surface              | Before | After |
| -------------------- | ------ | ----- |
| HTTP `/json/list`    | 1 (shell only) | 1 + N (shell + one per tab) |
| `Target.getTargets`  | 1      | 1 + N |
| `Page.getFrameTree` on shell | 1 + N (N iframes nested under shell) | 1 (no child frames for tab content) |
| Playwright `ctx.pages()` | 1 | 1 + N |

### After

Captured via `node scripts/playwright-signin.mjs http://127.0.0.1:3000`
followed by `node scripts/phase1-gate-check.mjs`:

```
Baseline page count: 2
  http://127.0.0.1:3000/                     ← workspace shell
  chrome-error://chromewebdata/              ← default VS Code tab (code-server
                                               not running locally, so the view
                                               errored — but the page target
                                               exists, which is what the gate
                                               measures)

Opening test tabs via __AIIDE__.tab.open …

After opening 2 tabs (count 4):
  http://127.0.0.1:3000/
  chrome-error://chromewebdata/
  https://example.com/                       ← new WebContentsView
  https://www.iana.org/                      ← new WebContentsView

Delta: +2 page targets (expected +2)

Closing test tabs …
After close, count = 2 (expected 2)

PHASE 1 GATE: PASS ✓
```

Three things this confirms:
1. Every `WebContentsView` shows up as a `type: "page"` target — i.e.,
   Playwright `connectOverCDP` will see one page per tab.
2. The open / close lifecycle is symmetric — opening N tabs adds exactly N
   targets; closing them returns to the prior count.
3. Failed-load tab content (`chrome-error://`) still creates a real page
   target. That's the right semantics — Phase 2's tab-id correlation will
   work the same whether or not the content loaded.

---

## 1.3 What's intentionally unchanged

- **Tab metadata stays in the renderer.** Order, label, groups, active-tab
  state, persistence — all still in `WorkspaceShell`'s React state +
  backend SSE. The main process knows only about view lifecycle. Cleanest
  split for the smallest blast radius.
- **Header rewriting (`X-Frame-Options` strip in `defaultSession`)** —
  kept. `WebContentsView`s don't need it (top-level pages have no
  embedding restrictions), but removing it would be invisible-to-impossible
  to reason about without a separate cleanup pass. Flagged as a future
  cleanup candidate.
- **Browser-fallback `<iframe>` path** — preserved in `PreviewPane`. When
  `window.__AIIDE__?.tab` is absent (regular browser), the legacy iframe
  render path runs unchanged. `npm run dev` still works.
- **No back/forward UI.** The plan's open question (now-trivial with
  `webContents.goBack/goForward`) is deferred — UX-equivalent migration.
- **Chat panel** — still plain React DOM. Excluded from the view registry
  by virtue of not being a workspace tab.

---

## 1.4 Carry-overs for later phases

- **EC2 frontend deployment.** Renderer changes (`preview-pane`,
  `workspace-shell`, `electronTabs.ts`, `captureIframeSnapshot.ts`) are
  only on disk locally. The desktop app's Platform sign-in flow routes to
  `https://frontend-<userId>.platform.bytescripterz.com/` — those instances
  still ship the pre-migration iframe code. Phase 1 gate was verified
  against the local frontend (manual URL `http://127.0.0.1:3000`). Before
  Phase 2 can be tested end-to-end, the renderer changes need to ship to
  EC2 (push to whatever pipeline drives the per-user EC2 frontend).

- **Snapshot/annotation flow under WebContentsView.** Capture path is
  ported (`webContents.capturePage` → PNG data URL), but the snapshot
  overlay UX hasn't been exercised end-to-end. Worth spot-checking the
  marker/comments → send-to-chat path on a real tab before Phase 2.

- **Tab-id correlation marker for Phase 2.** Not added yet. Phase 2 will
  need the `window.__tabId = "…"` marker injected via preload + re-injected
  on `did-navigate`, so Playwright `page.evaluate(() => window.__tabId)`
  can map page → tabId. Trivial follow-up — adding here would just bloat
  Phase 1.

- **CDP enumeration UX.** `Target.getTargets` and `/json/list` both work
  out of the box for `WebContentsView`s because they're top-level
  WebContents. No `Target.setAutoAttach` dance needed. Confirms the
  premise: the cost of the migration is paid once, in the bounds-contract
  plumbing, not in per-tool integration.

---

## 1.5 How to reproduce / re-verify

From `d:\ai-project\ai-workspace-desktopapp\`:

```powershell
# 1. Local frontend running on :3000 (one terminal)
cd ..\AIWorkspaceFrontEnd
npm run dev

# 2. Desktop app with CDP enabled (another terminal)
cd ..\ai-workspace-desktopapp
$env:AIIDE_CDP_PORT = "9222"; npm start

# 3. Sign in via Playwright (any terminal)
node scripts/playwright-signin.mjs http://127.0.0.1:3000

# 4. Run the gate check
node scripts/phase1-gate-check.mjs
```

`PHASE 1 GATE: PASS ✓` is the expected last line.
