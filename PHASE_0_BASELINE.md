# Phase 0 baseline — `<webview>` → `WebContentsView` migration

Captured against the current state of the desktop app + frontend renderer.
Phase 0 is read-only / additive: it documents what exists and adds an opt-in
CDP launch switch so the baseline `/json/list` can be inspected. No tab
plumbing has been changed yet.

> **No git branch was used for this phase per user instruction.** The single
> code change is the gated `--remote-debugging-port` switch in `main.js`. If
> the switch is unwanted as-is, set `AIIDE_CDP_PORT` to nothing (default) and
> behavior is identical to before.

---

## 0.1 Top finding — the plan's premise needs to be revisited

**The frontend renderer contains zero `<webview>` elements.** Tab content is
rendered with plain `<iframe>` in [PreviewPane](../AIWorkspaceFrontEnd/src/components/workspace/preview-pane.tsx#L186-L197):

```tsx
<iframe
  className="preview-iframe"
  src={url}
  title="Preview"
  loading="lazy"
  ref={iframeRef}
  onLoad={() => onLoadingChangeRef.current?.(tabId, false)}
  style={snapshot ? { visibility: "hidden" } : undefined}
/>
```

Searches confirming this:
- `grep -ri "<webview"` across `AIWorkspaceFrontEnd/` — no matches.
- `grep -ri "webview"` across `AIWorkspaceFrontEnd/` — one hit, an unrelated
  comment in [ConnectScreen.tsx:187](../AIWorkspaceFrontEnd/src/components/chat/ConnectScreen.tsx#L187).
- `grep "iframe"` across `AIWorkspaceFrontEnd/src/` — 4 files, all driven by
  the single `<iframe>` in `preview-pane.tsx`.

### Implications for the plan as written

The plan title `<webview> → WebContentsView` describes the wrong starting
point. The real migration is **`<iframe>` → `WebContentsView`**, and several
Phase 1 sub-tasks change in cost:

| Plan task                                              | Status against `<iframe>` baseline                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port event wiring from webview DOM events              | Nothing to port — current code only listens to `iframe.onLoad`. `did-navigate`, `page-title-updated`, etc. are **new** events the renderer doesn't currently consume.     |
| Port preload + IPC from guest                          | Nothing to port. The frontend `<iframe>` content is same-origin or cross-origin web pages; no preload is injected from the renderer side.                                 |
| Port session isolation (`<webview partition>`)         | Nothing to port. All iframes share the main window's default session.                                                                                                     |
| `setWindowOpenHandler` on the new view                 | New surface. Currently popups are caught by the main window's `setWindowOpenHandler` ([main.js:157-200](main.js#L157-L200)) — those would no longer fire for popups originating inside the WebContentsView; they must be wired on each view. |

In addition, several pieces of webview-specific main-process code are
**unreferenced in practice** under the current frontend:

- `webPreferences.webviewTag: true` on the main window ([main.js:137](main.js#L137)).
- The `will-attach-webview` handler that injects `preload-webview.js`
  ([main.js:208-213](main.js#L208-L213)).
- `app.on('web-contents-created')` branch checking `contents.getType() === 'webview'`
  ([main.js:312-321](main.js#L312-L321)).
- The `webview-popup-open` IPC handler ([main.js:325-337](main.js#L325-L337)).
- `preload-webview.js` itself.

These were presumably added during an earlier `<webview>`-based design and
left behind when the frontend switched to `<iframe>`. They are not blockers
for Phase 1, but they should be removed (or proven still used by some path
I haven't found) as part of the cleanup at the end of the migration.

The two go/no-go gates the plan calls out remain valid — they're about what
the Chromium side reports, not what the frontend renders:

- **Phase 1 gate:** tab content reports `type: "page"` in `/json/list`.
- **Phase 3 gate:** Playwright `connectOverCDP` enumerates one page per tab.

The baseline below establishes what the **current** values look like so
Phase 1's success is measurable.

---

## 0.2 Inventory — current tab content surfaces

Single rendering path: one `<iframe>` per `EditorTab`, mounted simultaneously
and hidden via `display:none` when inactive (so iframe state survives tab
switches — see [preview-pane.tsx:78-81](../AIWorkspaceFrontEnd/src/components/workspace/preview-pane.tsx#L78-L81)).

### Tab data model

Defined in [types.ts:1-13](../AIWorkspaceFrontEnd/src/types/types.ts#L1-L13):

```ts
type EditorTab  = { id: string; label: string; url: string; groupId?: string };
type TabGroup   = { id: string; label: string; color: string; collapsed: boolean };
```

### Special-purpose tab content

Not every tab is an iframe; the preview pane branches on URL:

1. `url === ""` → renders the [NewTabPage](../AIWorkspaceFrontEnd/src/components/workspace/new-tab-page.tsx)
   React component instead of an iframe ([preview-pane.tsx:145-154](../AIWorkspaceFrontEnd/src/components/workspace/preview-pane.tsx#L145-L154)).
2. `url === "aiide://ports"` → renders the [PortsView](../AIWorkspaceFrontEnd/src/components/workspace/PortsView.tsx)
   React component ([preview-pane.tsx:156-167](../AIWorkspaceFrontEnd/src/components/workspace/preview-pane.tsx#L156-L167)).
3. Anything else → `<iframe src={url}>` ([preview-pane.tsx:186-197](../AIWorkspaceFrontEnd/src/components/workspace/preview-pane.tsx#L186-L197)).

Implication for Phase 1: only branch 3 needs to migrate to `WebContentsView`.
Branches 1 and 2 stay as React DOM and must be **excluded from the registry**
so they are never enumerated as automatable tabs (mirrors the plan's chat-panel
exclusion).

### Initial tabs

```ts
// AIWorkspaceFrontEnd/src/constant/constants.ts
createInitialTabs(codeServerUrl) = [
  { id: "vscode-1", label: "VS Code", url: codeServerUrl },
]
```

So a fresh launch opens **one** iframe at the code-server URL.

---

## 0.3 Tab-manager API

The single source of truth is [WorkspaceShell](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx)
(React component, runs in the renderer). State lives there; child components
receive callbacks.

### State

- `tabs: EditorTab[]` — ordered list ([workspace-shell.tsx:68](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L68)).
- `activeTabId: string` — initially `"vscode-1"` ([workspace-shell.tsx:71](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L71)).
- `tabsRef: useRef<EditorTab[]>` — kept in sync with `tabs` so async handlers
  (open-tab IPC, SSE) can read the latest list synchronously ([workspace-shell.tsx:79-82](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L79-L82)).
- `groups: Record<string, TabGroup>` — color-grouped tab bar groups.
- `loadingTabIds: Set<string>` — drives the tab strip's loading sweep.
- `iframeRefs: Record<string, HTMLIFrameElement | null>` — registered by each
  `PreviewPane` via `onElementsReady` ([workspace-shell.tsx:145, 148-157](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L145)).
- Per-tab annotation state: `drawingsByTab`, `commentsByTab`, `snapshotByTab`.

### Operations (all in `workspace-shell.tsx`)

| Operation       | Function                  | Lines          | Notes                                                                                                                                                  |
| --------------- | ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open (new tab)  | `handleAddTab`            | 434-441        | Blank tab; ID generated by `nextTabId()` (monotonic counter — avoids same-ms collisions).                                                               |
| Open (URL)      | `handleOpenTab`           | 490-525        | Used by chat, PortsView, SSE `open_tab`. Translates raw `ip:port` → public service URL via `toPublicServiceUrl`. Switches to existing tab if URL match. |
| Navigate        | `handleTabNavigate`       | 464-483        | Replaces a tab's URL + label (used when the new-tab page picks a URL).                                                                                  |
| Select          | `setActiveTabId`          | inline         | Plain `useState` setter; passed to `EditorTabs` as `onSelectTab`.                                                                                       |
| Close           | `handleCloseTab`          | 572-631        | Refuses to close the last tab. Cleans up `drawingsByTab`, `snapshotByTab`, `commentsByTab`, `loadingTabIds`, and the `iframeRefs` / `drawingSvgRefs` entries. |
| Reorder         | `handleTabDrop`           | 416-421        | HTML5 drag-and-drop, reads source index from `dataTransfer`.                                                                                            |
| Reload (active) | `handleActiveTabReload`   | 165-177        | Imperative `iframe.src = "about:blank"` then restore — works around the cross-origin reload SecurityError.                                              |
| Back / Forward  | **Not implemented**       | —              | The current iframe-based design has no per-tab navigation history surfaced to the UI. This is **new behavior** Phase 1 will need to add (`webContents.goBack/goForward`) if the user wants it. |
| Group create    | `handleGroupCreate`       | 633-643        | Renderer-only — no main-process state.                                                                                                                 |
| Group assign    | `handleGroupAssign`       | 645-647        |                                                                                                                                                        |
| Group remove    | `handleGroupRemove`       | 649-666        |                                                                                                                                                        |
| Group toggle    | `handleGroupToggle`       | 668-673        |                                                                                                                                                        |
| Group rename    | `handleGroupRename`       | 675-680        |                                                                                                                                                        |

### Tab-strip events

`EditorTabs` ([editor-tabs.tsx:22-39](../AIWorkspaceFrontEnd/src/components/workspace/editor-tabs.tsx#L22-L39))
receives: `onSelectTab`, `onCloseTab`, `onAddTab`, `onTabDrop`,
`onGroupCreate/Assign/Remove/Toggle/Rename`. It does not have any access to
iframe contents.

### Restoration & external opens

- On mount, `WorkspaceShell` GETs `openedUrlsUrl()` (backend) and replays each
  URL through `handleOpenTab` ([workspace-shell.tsx:529-546](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L529-L546)).
- A backend SSE stream at `eventsUrl()` delivers `open_tab` events from MCP
  tool calls — these also go through `handleOpenTab` ([workspace-shell.tsx:550-570](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L550-L570)).

### Layout (relevant to Phase 1's bounds contract)

```ts
<section className="workspace"
  style={{ gridTemplateColumns: `minmax(0, 1fr) 4px ${chatWidth}px` }}>
```

The chat panel is **plain DOM** ([chat-panel.tsx](../AIWorkspaceFrontEnd/src/components/workspace/chat-panel.tsx),
no iframe / webview) — the plan's "chat-panel is itself a webview" branch
does **not** apply. The chat panel can stay as React DOM and be excluded from
the future tab registry by virtue of not being a tab at all.

Constants:
- `MIN_CHAT_WIDTH = 280` ([workspace-shell.tsx:32](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L32))
- `MAX_CHAT_WIDTH_RATIO = 0.7` ([workspace-shell.tsx:33](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L33))
- `DEFAULT_CHAT_WIDTH = 380` ([workspace-shell.tsx:31](../AIWorkspaceFrontEnd/src/components/workspace/workspace-shell.tsx#L31))
- Width persisted to `localStorage['ai-ide:chat-panel-width']`.

Phase 1's "content-rect contract" (renderer → main on every chrome change)
will need wiring through this `workspace` grid. The tab bar height,
`EditorOverlayToolbar` height (when visible), and chat-panel width all
contribute to the content rect.

---

## 0.4 Preload, session/partition, and IPC

### Main window webPreferences ([main.js:132-138](main.js#L132-L138))

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
  webviewTag: true,   // unused by current frontend; see 0.1
}
```

No explicit `partition` / `session` → default session.

### Renderer-facing preload — `preload.js`

Exposes a single `__AIIDE__` global ([preload.js:8-21](preload.js#L8-L21)):

- `__AIIDE__.isElectron`
- `__AIIDE__.electronVersion`
- `__AIIDE__.onOpenTab(cb)` — subscribe to `open-tab` IPC events from main
  (used when a popup is converted into a workspace tab).

Wired by the renderer in `workspace-shell.tsx` only indirectly: today the
new-tab flow goes through SSE + backend, not via `__AIIDE__.onOpenTab`. The
preload's listener is set up regardless; if no subscriber registers, the
event is dropped. Whether anything currently uses it in production needs
verification before Phase 1, but it is not on the critical path for the
migration.

### Connect-window preload — `preload-connect.js`

Used only by `connect.html` (modal sign-in window, never a tab). Exposes
`__AIIDE_CONNECT__.openPlatformBrowser`, `connectManual`, `getConfig`.
**Out of scope** for the migration.

### Webview-attached preload — `preload-webview.js`

Patches `window.open()` inside guest webviews to route through
`webview-popup-open` IPC. **Currently dead code** because the frontend has no
`<webview>` elements (see 0.1). Should be deleted as part of the cleanup at
end of migration, after confirming no future code path needs it.

### IPC handlers in main

- `webview-popup-open` ([main.js:325-337](main.js#L325-L337)) — dead (depends on `preload-webview.js`).
- `open-platform-browser` ([main.js:341-344](main.js#L341-L344)) — connect window only.
- `connect-manual` ([main.js:347-355](main.js#L347-L355)) — connect window only.
- `get-config` ([main.js:358-360](main.js#L358-L360)) — connect window only.

### Window-open routing for the main window ([main.js:157-200](main.js#L157-L200))

Every `window.open()` from the main window's WebContents is allowed as a
hidden popup; `did-create-window` then either:
- Opens it as its own `BrowserWindow` if the destination is a known payment /
  OAuth host (Stripe / PayPal / Google / etc — `STANDALONE_HOST_SUFFIXES`,
  [main.js:12-17](main.js#L12-L17)), **or**
- Sends `mainWindow.webContents.send('open-tab', { url, label })` so the
  renderer's `__AIIDE__.onOpenTab` subscribers can create a workspace tab.

After Phase 1, every `WebContentsView` will have its own WebContents and
needs `setWindowOpenHandler` + `did-create-window` wired the same way (or
delegated to a shared helper) so popups originating inside a tab keep
routing through this policy.

### Header rewriting (applies to all sessions today)

[main.js:386-399](main.js#L386-L399) strips `X-Frame-Options` and
`frame-ancestors` from every response in the default session, so cross-origin
content (Stripe, OAuth) can render inside the current `<iframe>` tabs.

**Phase 1 implication:** if each `WebContentsView` is given its own session
or partition, this `onHeadersReceived` rule must be installed on each one
(or kept on `session.defaultSession` if all views share it). The current
unconditional rule is the simplest port forward.

---

## 0.5 Launch switch added — `AIIDE_CDP_PORT`

Added at [main.js:80-91](main.js#L80-L91) (right after the single-instance
lock, before `app.whenReady()` as Electron requires for command-line
switches):

```js
const cdpPort = Number.parseInt(process.env.AIIDE_CDP_PORT ?? '', 10);
if (Number.isFinite(cdpPort) && cdpPort > 0 && cdpPort < 65536) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  dbg('remote-debugging-port enabled on 127.0.0.1:' + cdpPort);
}
```

- **Default OFF.** If `AIIDE_CDP_PORT` is unset, behavior is identical to
  before this change.
- **Loopback only.** `--remote-debugging-address=127.0.0.1` keeps the port
  unreachable off-box even on Electron builds whose default bind is `0.0.0.0`.
- **Logged.** Activation is recorded in `debug.log` via the existing `dbg()`
  helper so it's clear from a session log whether CDP was on.

Future phases tunnel only the authenticated MCP endpoint, never this port.

---

## 0.6 Acceptance gate — how to verify

The plan's Phase 0 acceptance gate is:

> Baseline `/json/list` captured showing guests; current tab API documented.

The tab-API + preload + IPC documentation is above. Capturing `/json/list`
requires a live process — here's exactly what to run on Windows PowerShell.

### Steps

1. From `d:\ai-project\ai-workspace-desktopapp`:

   ```powershell
   $env:AIIDE_CDP_PORT = "9222"
   npm start
   ```

2. Sign in / connect to a workspace so the **main window opens** (the connect
   window itself is also a target but isn't what we care about). Open one or
   two additional tabs via the `+` button or the new-tab-page URL picker so
   there is more than one iframe in flight.

3. In a second PowerShell:

   ```powershell
   (Invoke-WebRequest http://127.0.0.1:9222/json/list).Content | ConvertFrom-Json |
     Select-Object type, title, url | Format-Table -AutoSize
   ```

4. **Save the output** (paste it into this file under "0.7 Recorded baseline"
   below, or attach it to the migration tracking issue).

### What to expect

- The main window's renderer (Next.js workspace shell) shows up as
  `type: "page"` — that's the workspace renderer itself, not a tab.
- The **tab content iframes** show up as `type: "iframe"` (subframes of the
  main window's page target). This is the baseline we're trying to fix — and
  it's actually worse than the plan's stated baseline (`type: "webview"`)
  because subframes don't qualify as page targets the way top-level webview
  guests sometimes do.
- The connect window (if still open) appears as another `type: "page"`.
- VS Code / code-server iframe content may also show shared-worker /
  service-worker entries; those are noise for this gate.

### Phase 1 gate (for context, not run now)

After Phase 1's `<iframe>` → `WebContentsView` migration, re-running the same
command should show **one `type: "page"` entry per workspace tab** (in
addition to the shell renderer). That's the go/no-go signal for advancing to
Phase 2.

---

## 0.7 Recorded baseline

Captured against the live build on 2026-06-05. The desktop app was launched
with `AIIDE_CDP_PORT=9222`, signed in as `umarinfo002@gmail.com` via the
Platform sign-in flow (which deep-links back through `aiide://workspace?...`),
and the workspace shell loaded the user's 6 persisted tabs (VS Code, Odoo 19,
Document.docx, Employees.xlsx, Gym Site, Open Gym Subscriptions).

### What `/json/list` reports

```json
[ {
   "title": "AI IDE Studio",
   "type": "page",
   "url": "https://frontend-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/",
   "id": "EFE9D53C886F717412AD5FF6FB29EC3C"
} ]
```

**One target.** The HTTP `/json/list` endpoint only enumerates page-level
targets. Cross-origin OOPIF subframes are not exposed here, and same-origin
subframes are not exposed either — neither would appear regardless of how
many tabs the user has open.

### What the browser-level CDP `Target.getTargets` reports

After `Target.setDiscoverTargets({ discover: true })` on the browser-level
debugger (`/json/version` → `webSocketDebuggerUrl`):

```
TOTAL TARGETS: 1
BY TYPE: {"page": 1}
  page    attached=n    https://frontend-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/
```

**Still one target.** The cross-origin iframes for the tabs (each on its own
`*-<userId>.platform.bytescripterz.com` subdomain) are not surfaced as
discoverable targets by default. They would require `Target.setAutoAttach`
with `flatten: true` on a per-page session to be attached, and even then they
present as `type: "iframe"` — never `type: "page"`. Playwright's
`connectOverCDP` follows the same flow; in its `browserContext.pages()` list
the workspace would appear as exactly **one** page, with the 6 tabs
invisible.

### What the page actually contains (via Runtime.evaluate on the shell)

```json
{
  "title": "AI IDE Studio",
  "readyState": "complete",
  "iframeCount": 6,
  "tabsInDom": 6,
  "iframes": [
    { "src": "https://ide-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/?folder=%2Fhome%2Fubuntu",
      "className": "preview-iframe", "visible": true },
    { "src": "https://odoo-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/odoo",
      "className": "preview-iframe", "visible": false },
    { "src": "https://employees-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/edit?fileId=default-doc&type=docx&name=Document.docx",
      "className": "preview-iframe", "visible": false },
    { "src": "https://employees-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/edit?fileId=employees&type=xlsx&name=Employees.xlsx",
      "className": "preview-iframe", "visible": false },
    { "src": "https://gym-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/",
      "className": "preview-iframe", "visible": false },
    { "src": "https://odoo-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/odoo/gym-subscriptions",
      "className": "preview-iframe", "visible": false }
  ]
}
```

Confirms the rendering model documented in §0.2: every tab mounts its iframe
simultaneously, only the active one is visible (`display:none` on inactive
tabs via the `preview-frame` style).

### What `Page.getFrameTree` reports for the shell

```
[EFE9D53C] (no name)  https://frontend-…bytescripterz.com/
  [715140FD] (no name)  https://ide-…bytescripterz.com/?folder=%2Fhome%2Fubuntu
    [61FE83AB] (no name)  https://ide-…/static/out/.../webWorkerExtensionHostIframe.html
  [7642140E] (no name)  :
  [7922599F] (no name)  :
  [CAA0076A] (no name)  :
  [E8BEF8CE] (no name)  :
  [55267B43] (no name)  https://odoo-…bytescripterz.com/web/login?redirect=…
```

The 4 frames with `":"` as URL are the inactive tabs whose iframe `src` is
loading or stalled at the network layer (no first byte yet). The active
VS Code iframe (`715140FD`) has its own nested worker iframe — that one
appears as a true grandchild subframe regardless of how the migration is done.

### Conclusion vs the Phase 1 gate

The current state for Playwright automation purposes is:

| Surface              | Count | Notes                                                       |
| -------------------- | ----- | ----------------------------------------------------------- |
| HTTP `/json/list`    | 1     | workspace shell only                                        |
| `Target.getTargets`  | 1     | workspace shell only                                        |
| `Page.getFrameTree`  | 7     | shell + 6 tabs + 1 nested worker — not page targets         |
| DOM `<iframe>`s      | 6     | one per workspace tab                                       |
| User-visible tabs    | 6     | in the editor strip                                         |

Playwright `connectOverCDP` sees **1 page**, not 6. None of the tab content
is automatable as a tab today.

**Phase 1 success criterion (for reference):** the same captures after the
`<iframe>` → `WebContentsView` migration should show:

- `Target.getTargets` ≥ 7 (1 shell `page` + 6 tab `page`s).
- `/json/list` ≥ 7 with `type: "page"` for each tab.
- `Page.getFrameTree` on the shell shows zero child frames for tab content
  (because tab content is no longer rendered as DOM iframes — it's composited
  by the main process via `WebContentsView`).
- Playwright `browser.contexts()[0].pages()` returns one Page per tab.

---

## 0.8 Open questions for Phase 1

These should be answered before Phase 1 starts; they're not blockers for
Phase 0 itself.

1. **Back / forward UI.** Current iframe-based UI has no per-tab history
   navigation. Is the goal to add it now that `WebContentsView` makes it
   trivial (`webContents.goBack/goForward`)? Or stay UI-equivalent?
2. **Same-DOM annotation overlay.** Today, marker / comment / snapshot
   features overlay SVG and a snapshot `<img>` directly on top of the
   `<iframe>` in the same React tree. With `WebContentsView`, the content
   leaves the DOM — the snapshot overlay still works (it's a separate image)
   but `compositeSnapshotWithSvg` reads `iframe.getBoundingClientRect()`. The
   bounds will come from the `setBounds` call instead, which is fine, but the
   capture path (`captureIframeSnapshot`) likely uses `getDisplayMedia` against
   the iframe element and will need to switch to `webContents.capturePage()`
   in main. **This is a real Phase 1 sub-task that the plan doesn't call out.**
3. **Header rewriting per session.** Decide whether all `WebContentsView`s
   share `session.defaultSession` or get their own partition. The former is
   the cheapest port; the latter buys cookie isolation per tab if that's
   wanted.
4. **Dead-code removal.** When is the right moment to delete `webviewTag`,
   `will-attach-webview`, `preload-webview.js`, and the `webview-popup-open`
   IPC? Probably end of Phase 1, after confirming nothing inside the
   migration depended on them.
5. **`__AIIDE__.onOpenTab` consumers.** Confirm whether anything in the
   renderer currently registers a listener. If not, `did-create-window` →
   `mainWindow.webContents.send('open-tab', …)` is also dead and the popup
   flow in [main.js:157-200](main.js#L157-L200) can be simplified alongside.
