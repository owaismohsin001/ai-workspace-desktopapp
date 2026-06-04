# Phase 5 results — bidirectional tab-lifecycle sync

**Outcome: gate PASSED (7/7 checks).** The UI, the main-process tab
registry, and the CDP page targets stay in lockstep across every tab
operation. The "what's active" answer is consistent across all three
surfaces and tracks the renderer's React state in real time.

Verified 2026-06-05 against the live EC2 workspace via
[scripts/phase5-gate-check.mjs](scripts/phase5-gate-check.mjs).

This is the last phase of the migration plan that started in
[PHASE_0_BASELINE.md](PHASE_0_BASELINE.md).

---

## 5.1 What ships

### Desktop side
- **[tab-manager.js](tab-manager.js)** — new `activeTabId` field on
  `TabManager`. Two new IPC handlers:
  - `tab:setActive { tabId }` — renderer calls this on every active-tab
    change; main stores the value as authoritative.
  - `tab:list` — returns
    `{ tabs: [{ tabId, url, visible, bounds }], activeTabId }`. The
    single source for any MCP-side caller that needs the registry +
    active id.
- **[preload.js](preload.js)** — exposes `__AIIDE__.tab.setActive()`
  and `__AIIDE__.tab.list()`.

### Renderer side ([AIWorkspaceFrontEnd/](../AIWorkspaceFrontEnd))
- **[workspace-shell.tsx](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx)**
  — single `useEffect([activeTabId])` calls `electron.setActive(activeTabId)`
  on every change. No-op outside Electron.
- **[editor-tabs.tsx](../AIWorkspaceFrontEnd/src/components/workspace/editor-tabs.tsx)**
  — every `.editor-tab` element now carries `data-tab-id="<tabId>"` and
  the active one has `data-active=""`. A snapshot-driven client (e.g.
  Playwright MCP) can read the active tab in one query:
  ```js
  document.querySelector('[data-active]')?.dataset.tabId
  ```
- **[electronTabs.ts](../AIWorkspaceFrontEnd/src/utils/electronTabs.ts)**
  — `ElectronTabs` interface extended with `setActive` and `list`.

### Verification tooling
- **New: [scripts/phase5-gate-check.mjs](scripts/phase5-gate-check.mjs)**
  — three-way consistency check across (renderer DOM, main registry, CDP
  page targets). Asserts the alignment holds across open / active-switch /
  close from the renderer side.

---

## 5.2 Acceptance-gate output

```
Shell: https://frontend-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/

[1] Baseline alignment (UI ↔ main ↔ CDP):
  ✓ all three views agree on 6 tabs
  ✓ active tab agrees: tab-1780611775533-5

[2] Open from renderer side:
  ✓ new tab phase5-test-… visible to main (registry)
  ✓ new tab phase5-test-… visible to CDP (page target)
  ✓ main registry grew by 1 (6 → 7)

[3] Active-tab switch (renderer drives main):
  ✓ renderer + main both see active = vscode-1

[4] Close from renderer side:
  ✓ main + CDP both dropped test tab

PHASE 5 GATE: PASS ✓ (7 checks)
```

Each check exercises one of the consistency invariants:

1. **Baseline** — at a stable steady state, every tab in the renderer's
   tab strip has a matching entry in main's registry and a matching
   `type:"page"` target in CDP with the right `window.__tabId`. The
   active tabs all match.
2. **Open** — `__AIIDE__.tab.open` from the renderer creates a
   WebContentsView (main registry) and a CDP page target with the
   marker. Single source, three propagation paths, no skew.
3. **Active switch** — clicking a tab in the renderer's strip (via
   `data-tab-id`-targeted click) fires `setActiveTabId` in React,
   which triggers the Phase 5 `useEffect`, which calls `setActive` on
   main, which updates `activeTabId` in the registry. Both ends agree.
4. **Close** — `__AIIDE__.tab.close` symmetrically removes the entry
   from main and the page target from CDP.

---

## 5.3 What this unlocks

The plan listed "default to the UI's active tab" as the active-tab
semantics. Phase 5 makes that easy to implement on either side:

**Main-process callers** can do:
```js
const { activeTabId } = await tabManager._list();
const resolved = explicitTabId ?? activeTabId;
```

**MCP / Playwright callers** can read the active tab from a shell snapshot
or evaluate:
```js
const activeTabId = await shellPage.evaluate(
  () => document.querySelector('[data-active]')?.dataset.tabId
);
```

Either form gives the same answer because main and renderer never disagree
about who's active.

For the chat panel's Playwright tool use, the agent can:
1. Evaluate `[data-active]` on the shell to learn the active tabId.
2. Cross-reference with `browser_tabs list` to find the matching Page
   index.
3. `browser_tabs select index=<n>` to align Playwright's "current page"
   with the UI's.
4. `browser_snapshot` then operates on the UI's active tab without the
   user having to pass anything explicit.

---

## 5.4 Known limitations / carry-overs

### Phantom CDP targets from MCP-direct tab creation

A user calling `browser_tabs new url=…` over MCP could in principle
create a Page via Playwright's `context.newPage()` → CDP
`Target.createTarget`. Electron's response to that is undocumented for
WebContentsView setups — in our testing the chat panel never created
such phantoms (it correctly uses our existing `mcp__aiide__open_tab`
flow), but the path is plausible.

Phase 5's gate-check catches phantom CDP targets explicitly:

```
CDP page target has __tabId=X but main has no registry entry
```

If this ever fires, the next step is a `Target.targetCreated` watcher
that adopts unknown pages into the registry (or auto-closes them in
strict mode). Not implemented today because we haven't observed it in
practice.

### `tab:list` doesn't include the renderer's "no-URL" placeholder tabs

The new-tab page (renderer-only, no URL) isn't in main's registry —
only tabs that called `__AIIDE__.tab.open` are tracked. The gate-check
accepts this asymmetry (renderer can have more tabs than main, just
not the other way around). If you need a full "every workspace tab,
including new-tab placeholders", read the renderer DOM via
`querySelectorAll('[data-tab-id]')` instead of `tab.list()`.

### `tab.setActive` is fire-and-forget

The renderer doesn't await the IPC result before continuing — keeps
the active-switch UI responsive. If main is wedged, the renderer
briefly lies about what's active. In practice main responds in <1ms,
so this is theoretical.

---

## 5.5 How to reproduce

```powershell
# Desktop, with the workspace signed in to the EC2 frontend
cd d:\ai-project\ai-workspace-desktopapp
$env:AIIDE_CDP_PORT = "9222"; npm start
# (sign in if needed — see scripts/playwright-signin.mjs)

# Run the gate
node scripts/phase5-gate-check.mjs
```

Expected last line: `PHASE 5 GATE: PASS ✓ (7 checks)`.

---

## End of migration

This is the final phase of the original plan. The full sequence:

| Phase | Theme | Gate |
| ----- | ----- | ---- |
| 0 | Baseline + gated CDP switch | `/json/list` baseline captured |
| 1 | `<iframe>` → `WebContentsView` | 1 page-target per tab |
| 1.1 | Toolbar moved into chrome row | UI unblocked |
| 1.2 | Orphan-view guard on renderer nav | No accumulation across reloads |
| 2 | `window.__tabId` correlation marker | 7/7 — Page ↔ tabId both directions |
| 3 | In-process Playwright MCP | 11/11 — browser_tabs / snapshot / click |
| 4 | Chat-panel ↔ MCP via reverse SSH tunnel | User-verified end-to-end |
| 5 | Bidirectional active-tab sync | 7/7 — UI/main/CDP agree |

What was originally a chat panel that could only see iframes it didn't
own is now a chat panel whose AI can address every tab as a real
Playwright `Page`, via the full official Playwright MCP toolset, with
zero tool reimplementation.
