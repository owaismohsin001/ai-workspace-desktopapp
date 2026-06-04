# Phase 3 results — in-process Playwright MCP

**Outcome: gate PASSED (11/11 checks).** The official Playwright MCP
toolset runs in-process inside the Electron main process, connected to
our own CDP endpoint, driving the real `WebContentsView` tabs. No tool
reimplementation; no external `npx @playwright/mcp` subprocess.

Verified 2026-06-05 against the live EC2 workspace
(`umarinfo002@gmail.com`, 6 persisted tabs + 1 test tab) via
[scripts/phase3-gate-check.mjs](scripts/phase3-gate-check.mjs).

---

## 3.1 What ships

- **New: [mcp-server.js](mcp-server.js)** — bootstrap module that
  `require('@playwright/mcp').createConnection(...)`'s the MCP server,
  pointed at our own `--remote-debugging-port` via
  `browser.cdpEndpoint`. Wires the resulting `Server` to a
  `StreamableHTTPServerTransport`, exposed over a plain Node `http`
  server on **127.0.0.1 only**.
- **New: [scripts/phase3-gate-check.mjs](scripts/phase3-gate-check.mjs)**
  — 11-check end-to-end gate (see §3.3).
- **[main.js](main.js)** — gates the whole thing behind
  `AIIDE_MCP_PORT`. Defaults off; if set, requires `AIIDE_CDP_PORT` to
  also be set (the MCP server needs the CDP endpoint to attach to). The
  server starts after `app.whenReady()` and is torn down on
  `window-all-closed`.
- **[package.json](package.json)** — `@playwright/mcp` and
  `@modelcontextprotocol/sdk` added to `dependencies`; `mcp-server.js`
  added to `build.files`.

No renderer-side changes. The whole MCP surface is desktop-app only.

### Tool capabilities enabled

Per the plan's "enable all the version supports" directive, the
`@playwright/mcp@0.0.75` capability set we enable is:

```
core, core-navigation, core-tabs, core-input,
network, pdf, vision, devtools
```

Explicitly excluded:
- `core-install` — would offer to install Playwright browsers; pointless
  when we're attaching to a running Electron via CDP.
- `config` — server-self-configuration tools, not relevant for end users.
- `storage`, `testing` — opt-in capabilities reserved for later phases if
  workflows need them.

`mcpClient.listTools()` reports **43 tools** with this set.

---

## 3.2 Acceptance-gate output

```
Shell: https://frontend-6a13f1bcc7af067a0028324b.platform.bytescripterz.com/
Test tab: phase3-test-1780608863131 → https://example.com/
  ✓ MCP client connected to http://127.0.0.1:9090/
  ✓ tool exposed: browser_tabs
  ✓ tool exposed: browser_snapshot
  ✓ tool exposed: browser_click
  (total tools exposed: 43)

browser_tabs list:
  ✓ test tab visible in browser_tabs output
  ✓ found test tab at index 5

browser_tabs select → browser_snapshot:
  ✓ selected tab 5
  ✓ snapshot contains "Example Domain"
  ✓ found outbound link ref: e6

browser_click:
  ✓ browser_click returned without error
  ✓ navigation landed on iana.org (post-click snapshot has iana content)

PHASE 3 GATE: PASS ✓ (11 checks)
```

Each check validates a different invariant Phase 4 (remote transport
+ auth) and downstream Agent SDK usage depend on:

1. **MCP transport handshake works** over StreamableHTTP on loopback.
2. **The full tool surface is registered** — not just `core`; the
   capability list reaches the wire correctly.
3. **`browser_tabs list` enumerates real `WebContentsView` tabs** —
   integration with our CDP setup actually surfaces our tabs as
   Playwright "tabs", not as separate disconnected browsers.
4. **`browser_tabs select` makes a chosen tab the active target**.
5. **`browser_snapshot` returns a usable accessibility tree** with
   `[ref=eXX]` element references — the data Phase 3+ tools need to
   parameterize subsequent calls.
6. **`browser_click` executes against a snapshot-derived ref** — the
   most common interaction and the canonical "the engine actually
   drives the page" test.
7. **Click triggers a real navigation** observable in a fresh snapshot.

---

## 3.3 Design notes

### Why in-process (not `npx @playwright/mcp` subprocess)

The plan called this out:

> MCP server runs **in-process** (main process), not as an external
> `npx` child.

The in-process choice has three real benefits:

1. **Lifecycle locked to the app.** No separate process to start, stop,
   monitor, or restart on crash. `app.whenReady` → server up;
   `window-all-closed` → server down.
2. **Connection latency is loopback HTTP**, not external IPC.
3. **Phase 4 hardening lives in one place.** Adding token auth and
   tunneling means modifying one Node http handler, not coordinating
   with an external `npx` subprocess's CLI args.

### Why StreamableHTTP, not stdio

Inside Electron's main process, stdio is owned by Electron itself —
not usable as an MCP transport. The two practical choices are SSE and
the newer Streamable HTTP. We pick Streamable HTTP because:
- It's the current MCP spec recommendation.
- It can be exposed over loopback today, and trivially tunneled in
  Phase 4 (SSH reverse tunnel or Tailscale) without changing the
  server code.

### Why `additionalArguments` on each view (Phase 2 recap)

The MCP `browser_click`-style tools need an element reference, and the
ref comes from `browser_snapshot`. The ARIA tree comes from a real
Playwright `Page` object. For Phase 4's per-tab routing (and the
Agent SDK's "act on tab X" calls), being able to map a `Page` back to
our renderer's `tabId` is essential. Phase 2's `window.__tabId` marker
is what makes that mapping cheap. None of Phase 3 explicitly uses
`__tabId` yet — `browser_tabs select` works by index against
Playwright's own enumeration — but Phase 4 will need to translate
"the user's tab id" → "this Playwright Page" via `evaluate(() =>
window.__tabId)`.

---

## 3.4 Known limitations / carry-overs

### Single-session per server instance

The current `mcp-server.js` wires **one** `Server` instance to **one**
`StreamableHTTPServerTransport`. After the first client's `initialize`
handshake completes, subsequent `initialize` requests from a second
client return:

```
{"code":-32600,"message":"Invalid Request: Server already initialized"}
```

Hit during gate-development when an earlier curl probe initialized the
server, then the gate-check's MCP client tried to re-initialize.
Workaround: restart Electron between client sessions.

**Phase 4 fix:** route by `mcp-session-id` header, instantiate a new
`Server` per session, share a single `BrowserContext` between them
(via `config.sharedBrowserContext = true`). Sketch:

```js
const sessions = new Map();   // sessionId → { server, transport }
function handle(req, res, body) {
  const sid = req.headers['mcp-session-id'];
  let entry = sid ? sessions.get(sid) : null;
  if (!entry && isInit(body)) entry = await spawnSession();
  await entry.transport.handleRequest(req, res, body);
}
```

Not blocking Phase 3 (the gate exercises one client at a time, which
is exactly the in-scope case). Flagged here so Phase 4 doesn't forget.

### No auth + only loopback

Per the plan:

> The remote-debugging port is **never** exposed off-box; only the
> authenticated MCP endpoint is tunneled.

Today the MCP endpoint is just a loopback HTTP server with **no auth**.
That's fine because nothing else on the box should be talking to it.
Phase 4 adds:
- Bearer token check on every request.
- Reject without the token even on loopback (defense in depth — other
  processes on the same machine shouldn't be able to drive the app).
- SSH reverse tunnel or Tailscale, so the remote Agent SDK can reach
  the loopback endpoint without ever exposing it on a public IP.

### Snapshot-format coupling in the gate-check

`scripts/phase3-gate-check.mjs` parses the snapshot's text format to
find a `[ref=…]` token for `browser_click`. Playwright MCP's snapshot
format is informal and has already changed once during this session
(example.com's link text went from "More information…" to "Learn
more"). The matcher accepts both. If the MCP snapshot format itself
ever shifts, the gate-check needs updating — the underlying behavior
would still be correct.

---

## 3.5 How to reproduce

```powershell
# 1. App running with CDP + MCP both enabled, signed in
cd d:\ai-project\ai-workspace-desktopapp
$env:AIIDE_CDP_PORT = "9222"
$env:AIIDE_MCP_PORT = "9090"
npm start

# 2. Run the gate
node scripts/phase3-gate-check.mjs
```

Expected last line: `PHASE 3 GATE: PASS ✓ (11 checks)`.

If you re-run the gate without restarting the app, you'll see the
single-session error described in §3.4. Restart Electron between runs
until Phase 4 lands.
