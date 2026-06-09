# visual-edit

A platform tool with two surfaces (see `../../live-editor-plan/visual-edit-tool-plan.md`):

- **Human** — a live visual editor. Point at elements on the loaded page, drop
  numbered pins, edit them through the inspector and see changes applied live.
- **LLM** — annotations. Every live edit is recorded as an exact `{ from → to }`
  delta keyed to its pin. The chat agent reproduces the changes **in source**,
  then pixel-diffs the render against the captured target.

## Where the code lives

| Concern | File |
| --- | --- |
| In-page runtime (live CSS preview, computed-style capture, pin overlay) | `preview-agent.js` (injected source) |
| Host-side CDP picker + agent bridge | `picker.js` (`webContents.debugger`) |
| Session: pin list + annotation deltas + payload | `session.js` |
| IPC surface + session registry | `index.js` (`visual-edit:*`) |
| Tool descriptor | `manifest.json` |
| Verification oracle (runs in the workspace) | `verify.js` (pixelmatch recipe) |
| Renderer accessor | `AIWorkspaceFrontEnd/src/utils/electronVisualEdit.ts` |
| Inspector panel | `AIWorkspaceFrontEnd/src/components/workspace/VisualEditorPanel.tsx` |
| Toolbar button + session wiring | `editor-overlay-toolbar.tsx`, `workspace-shell.tsx` |
| Chat handoff prompt | `AIWorkspaceFrontEnd/src/utils/visualEditPayload.ts` |

## Architecture notes / deliberate deviations from the plan

- **Picking is host-side over CDP** (`Overlay.setInspectMode`, browser-rendered,
  one-shot → re-armed after every pick) exactly as the plan locks in. We drive it
  through Electron's in-process `webContents.debugger` rather than the shared 9222
  WS endpoint — this sidesteps the `connectOverCDP` bus-worker assertion and keeps
  the picker off the endpoint the Playwright MCP server uses.
- **The numbered-pin overlay lives in-page** (in the injected preview agent),
  *not* in a separate host-side WebContentsView. The plan chose a host overlay to
  avoid injected JS — but the plan already injects the preview agent for live CSS,
  so reusing it for the overlay is simpler and keeps badges glued to elements via
  in-page `getBoundingClientRect` (no CDP round-trips, throttled to ~12fps).
  Page→host events (badge click, pin detached on re-render) ride the CDP Runtime
  binding `__ve_emit__`.
- **`applyEdits` / `verify` are not main-process ops.** The source edit + the
  pixel-diff run inside the user's workspace via the chat agent's existing
  Playwright MCP access (`AIIDE_MCP_PORT`). `buildEditTask` produces exactly what
  that agent consumes; `verify.js` is the diff recipe it runs.

## Manual test (full stack)

The picker needs the live Electron app attached to an EC2 workspace. The in-page
agent + the compose/decompose helpers are already unit-verified (real Chrome via
playwright-core, and a shadow/colour round-trip).

1. Launch the desktop app signed in to a workspace; open a tab with a real web
   page (a running preview, not the "New Tab" page). **Close DevTools on that tab**
   — a debugger session and DevTools can't co-exist on one view.
2. Click the **Visual edit** button in the editor toolbar (square-with-cursor
   icon). The inspector docks on the right and the view shrinks by 300px.
3. Click **Pick element**, then click elements on the page → numbered pins appear,
   each capturing its computed styles.
4. Select a pin, change properties → the page updates live; the annotation readout
   shows `from → to`.
5. Click **Apply in code** → the target screenshot is attached to chat and a
   structured prompt is drafted. Send it; the agent edits source and verifies.

### Phase checklist (plan §"Build phases")

1. CDP picker — `picker.js` ✓ (bridge verified against Chrome)
2. Overlay + tracking — in `preview-agent.js` (in-page) ✓
3. Inspector integration — `VisualEditorPanel.tsx` (seed + onEdit + compose) ✓
4. Live preview agent — `preview-agent.js` (`adoptedStyleSheets` + contentEditable) ✓
5. Annotation management — `session.js` (add/remove/renumber/note) ✓
6. Payload builder — `session.buildPayload` ✓
7. Edit subagent — chat agent via `visualEditPayload.ts` handoff
8. Verify loop — `verify.js` (agent runs it via Playwright MCP)
9. Platform wiring — `index.js` + `manifest.json` + main/preload ✓
