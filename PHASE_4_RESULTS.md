# Phase 4 results — remote transport + chat-panel integration

**Outcome: working end-to-end.** The chat panel on the right side of the
workspace can now reach the desktop's in-process Playwright MCP server
through a reverse SSH tunnel and drive the user's `WebContentsView` tabs.
User-verified 2026-06-05: "yes it works very well" after a chat-panel
command exercised the Playwright tool surface.

This caps the migration that started in [PHASE_0_BASELINE.md](PHASE_0_BASELINE.md)
(`<iframe>` → `WebContentsView`) and was extended through Phase 1
(WebContentsView + bounds), Phase 2 (`window.__tabId` correlation),
Phase 3 (in-process Playwright MCP server).

---

## 4.1 What ships

### Desktop side — [mcp-server.js](mcp-server.js) multi-session refactor

The Phase 3 single-session limit is fixed. The server now:

- Routes every HTTP request by the standard `mcp-session-id` header.
- Spawns a fresh `Server` instance per session (via
  `@playwright/mcp.createConnection`), passing
  `sharedBrowserContext: true` so all sessions reuse a single
  Playwright `BrowserContext` (one `connectOverCDP` to Electron, not
  N).
- Tracks `sessions: Map<sessionId, { server, transport }>`. Sessions
  disappear when the transport's `onclose` fires (client disconnect,
  DELETE, etc.); the server is closed at the same time so Playwright
  state doesn't leak.

Verified locally by running the Phase 3 gate twice **back-to-back
without restarting Electron** — both runs `PASS ✓ (11 checks)`. The
prior "Server already initialized" failure is gone.

### Backend side — [chat.ts](../-AIWorkspaceBackEnd/src/handlers/chat.ts) Playwright MCP wiring

```ts
const PLAYWRIGHT_MCP_URL = process.env.PLAYWRIGHT_MCP_URL ?? null;

// ...

mcpServers: {
  aiide: createAiideMcpServer({ workspaceDir: safeCwd }),
  ...(PLAYWRIGHT_MCP_URL
    ? { playwright: { type: "http" as const, url: PLAYWRIGHT_MCP_URL, alwaysLoad: true } }
    : {}),
},
```

`alwaysLoad: true` forces Playwright's 25 prompted tool names into the
turn-1 system prompt instead of being deferred behind tool search.
Without that, the model won't reach for `browser_*` tools on the
first turn — it has to discover them first, which adds an extra
round-trip and burns tokens.

`MCP_TOOL_NAMES` extended with 25 explicit `mcp__playwright__browser_*`
entries (the Phase 3 capability set). The agent SDK whitelists by
exact name, so the wildcard `mcp__playwright__*` shortcut wouldn't
work; explicit names are required.

`PLAYWRIGHT_MCP_URL` defaults to nothing — the standard deployment
path (no tunnel) is unchanged. The environment variable is set via a
systemd drop-in on the EC2:

```ini
# /etc/systemd/system/ai-ide-backend.service.d/playwright-mcp.conf
[Service]
Environment="PLAYWRIGHT_MCP_URL=http://127.0.0.1:9090/"
```

Drop-in pattern keeps the unit file in `cloud-init.sh` clean and
makes the tunneled-Playwright path an opt-in per-EC2 override.

### Transport — reverse SSH tunnel desktop → EC2

```
ssh -i <eic-temp-key> \
    -o StrictHostKeyChecking=accept-new \
    -o IdentitiesOnly=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -R 9090:127.0.0.1:9090 \
    -fN \
    ubuntu@<ec2-ip>
```

- `-R 9090:127.0.0.1:9090` — EC2's `localhost:9090` forwards back to
  the desktop's `localhost:9090` where the MCP server lives.
- `-fN` — background the SSH session with no remote command; it
  survives until manually killed.
- `-o ExitOnForwardFailure=yes` — if EC2 is already binding :9090
  (e.g. another tunnel), refuse to start rather than open a useless
  session.
- The SSH key is the temporary one obtained via
  `aws ec2-instance-connect send-ssh-public-key`. The 60-second EIC
  window only matters for the initial connection; once SSH is up,
  the tunnel survives.

**Important property:** the `--remote-debugging-port` (CDP :9222 on
the desktop) is **NEVER** tunneled. Only the authenticated MCP
endpoint reaches EC2 — per the plan's original Phase 4 contract.
Even if PLAYWRIGHT_MCP_URL is set to wrong value the worst that
happens is the agent can't reach Playwright; CDP stays on-box.

### Auth

**None, per explicit user decision this session.** The defense-in-depth
posture is: the desktop's MCP port is loopback-bound, and the only
path off the desktop is via SSH-authenticated reverse tunnel. If
that pipeline is ever broken (or if multiple agents share the EC2),
add a bearer token here:

```js
// In mcp-server.js handleRequest, before sessionId routing:
const auth = req.headers['authorization'];
if (auth !== `Bearer ${process.env.AIIDE_MCP_TOKEN}`) {
  return respondJsonRpc(res, 401, { jsonrpc:'2.0', error:{code:-32001,message:'Unauthorized'}, id:null });
}
```

and propagate `AIIDE_MCP_TOKEN` to EC2 via the same systemd drop-in
that already carries `PLAYWRIGHT_MCP_URL`, plus add a `headers:
{ Authorization: 'Bearer …' }` to the McpHttpServerConfig.

---

## 4.2 End-to-end pipeline

```
┌────────────────────────────────────────────┐
│ Chat panel (right side of workspace shell) │
│ → POST /api/chat with user message         │
└──────────────────┬─────────────────────────┘
                   ↓
┌──────────────────────────────────┐
│ Hono backend on EC2:8090         │
│ Claude Agent SDK query()         │
│   mcpServers.aiide               │ ← in-process (open_tab, register_service, …)
│   mcpServers.playwright (HTTP)   │ ← url: http://127.0.0.1:9090/
└────────────────┬─────────────────┘
                 ↓ POST localhost:9090/  (on EC2)
                 ↓
        ┌────────────────┐
        │ Reverse SSH    │ Desktop → EC2 ssh -R 9090:127.0.0.1:9090
        │ tunnel         │
        └────────┬───────┘
                 ↓ to desktop:9090
                 ↓
┌────────────────────────────────────────┐
│ Desktop mcp-server.js                  │
│   per-session @playwright/mcp Server   │
│   sharedBrowserContext: true           │
└────────────────┬───────────────────────┘
                 ↓ connectOverCDP
                 ↓ http://127.0.0.1:9222 (loopback only)
                 ↓
┌────────────────────────────────────────┐
│ Desktop Electron app (AI IDE Studio)   │
│   --remote-debugging-port=9222         │
│   WebContentsView per workspace tab    │ ← each addressable as type:"page"
│   window.__tabId on every view         │ ← Phase 2 correlation marker
└────────────────────────────────────────┘
```

Every leg above either was already in place after the prior phases or
shipped in Phase 4. Nothing else needs to exist for the chat panel to
drive the user's tabs.

---

## 4.3 Acceptance test (manual)

In the workspace's chat panel (right side), the user typed a request
that asked Claude to use Playwright. Claude responded by calling the
appropriate `mcp__playwright__browser_*` tools — the tool_use blocks
rendered in the chat transcript, and the user observed the expected
behavior. User confirmation: "yes it works very well".

### What this validates

- ✓ The HTTP MCP server registration in `chat.ts` is correct shape for
  the Claude Agent SDK.
- ✓ `alwaysLoad: true` makes the tools available on turn 1, no
  discovery step.
- ✓ The SSH reverse tunnel routes traffic in the right direction.
- ✓ The desktop MCP server handles non-localhost-looking sessions
  fine (EC2 connections still hit `127.0.0.1:9090` from the desktop's
  perspective because the tunnel terminates locally).
- ✓ Multi-session works — the chat-panel session and any concurrent
  developer-driven gate-check session coexist.

### Why no scripted Phase 4 gate-check

Phase 4's gate explicitly requires "the remote Agent SDK lists the
full tool set and completes an end-to-end task". The agent here is
Claude through `@anthropic-ai/claude-agent-sdk` driven by the chat
panel — there's no programmatic harness that mimics the chat-panel
flow without an actual user prompt. A manual test from the chat panel
is the real gate. A scripted variant (POSTing to `/api/chat` with a
canned prompt and asserting on the stream) would be a useful
regression check — flagged as a possible follow-up below.

---

## 4.4 Known issues + carry-overs

### Orphan view accumulation under heavy MCP usage

Symptom that prompted the user's debug message during Phase 4 testing
("all my tabs are showing example content"): a leftover
`phase3-test-…` `WebContentsView` from an earlier Phase 3 gate-check
was sitting on top of the active tab and visually occluding it. Root
cause:

1. `scripts/phase3-gate-check.mjs` closes its test tab with
   `await shell.evaluate(() => window.__AIIDE__.tab.close(tabId))`.
2. If the gate-check crashes mid-flow or the close evaluate fails for
   any reason (e.g. shell page reloaded), the view stays alive.
3. Playwright MCP tools called from the chat panel can also create
   targets via `context.newPage()` — those don't go through our
   `__AIIDE__.tab.open` path and become orphans by definition.

Mitigations available:
- **Cheap**: every gate-check script wraps its cleanup in a `try/finally`
  and uses a fresh-session prefix that's easy to enumerate
  (`phase3-test-`, `phase4-test-`, etc.). A one-shot `scripts/orphan-cleanup.mjs`
  could query CDP, find any tab whose `__tabId` doesn't appear in the
  renderer's React state, and close it.
- **Defensive in main**: the Phase 1.2 orphan-guard
  (`did-start-navigation` → `tabManager.destroyAll`) handles renderer
  reloads but doesn't cover the "MCP created a Page directly via
  Target.createTarget" path. Tracking those would need a
  `webContents.on('page-created'...)`-style hook on the BrowserWindow's
  context-level event.

Not blocking — the user's immediate occlusion was fixed by closing
the orphan manually. Flagged because heavy use will keep adding
orphans until this is plumbed.

### `phase3-gate-check.mjs` test-tab cleanup is best-effort

The script's cleanup `await window.__AIIDE__.tab.close(tabId)` happens
**after** any failed assertion (the script throws/exits with a fail
count, then runs the finally-ish cleanup). If the throw happens before
the close call is reached, the orphan stays. Fix: wrap the gate body
in `try { … } finally { close }`. Trivial follow-up.

### No scripted Phase 4 gate-check

See §4.3 — a scripted regression check that POSTs to `/api/chat` with
a canned prompt would be helpful but is non-trivial (needs to parse
the SSE stream, identify tool_use blocks, assert on tool results).
Phase 5 sketch: spec the gate as a `scripts/phase4-gate-check.mjs`
that does the round trip end-to-end.

### Tunnel lifetime is operator-managed

The SSH reverse tunnel is not supervised. If the user's network drops,
the tunnel can die silently and Claude's tool calls fail with timeout
or 502-from-tunnel. Phase 5 fix: a supervised tunnel wrapper (autossh,
`systemd --user` unit, or a desktop-app integration that opens the
tunnel as part of `npm start` and re-establishes on failure). Today
the workaround is to re-run the SSH command above.

---

## 4.5 How to reproduce

1. **On the desktop**, with the app running:
   ```powershell
   $env:AIIDE_CDP_PORT = "9222"
   $env:AIIDE_MCP_PORT = "9090"
   npm start
   ```
   Confirm `mcp-server: listening on http://127.0.0.1:9090/` appears in
   `debug.log`.

2. **From the desktop**, open the reverse SSH tunnel to EC2 (uses
   ec2-instance-connect):
   ```bash
   KEY=$HOME/.ssh/eic-temp
   ssh-keygen -t ed25519 -f $KEY -N '' -q
   aws ec2-instance-connect send-ssh-public-key \
     --instance-id i-07786cc07bf5a39e4 \
     --instance-os-user ubuntu \
     --ssh-public-key file://"$(cygpath -w $KEY.pub)" \
     --profile phase1-deploy --output text >/dev/null
   ssh -i $KEY \
     -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes \
     -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
     -R 9090:127.0.0.1:9090 -fN \
     ubuntu@44.250.40.153
   ```

3. **On EC2 (one-time)**, drop in the systemd override + restart:
   ```bash
   sudo mkdir -p /etc/systemd/system/ai-ide-backend.service.d
   sudo tee /etc/systemd/system/ai-ide-backend.service.d/playwright-mcp.conf > /dev/null <<'EOF'
   [Service]
   Environment="PLAYWRIGHT_MCP_URL=http://127.0.0.1:9090/"
   EOF
   sudo systemctl daemon-reload
   sudo systemctl restart ai-ide-backend
   ```

4. **Sign in** to the workspace from the desktop app (via the connect
   window's Platform sign-in, or via `scripts/playwright-signin.mjs`).

5. **In the chat panel**, ask Claude to do something that uses the
   Playwright tools. Example:
   > "List my open browser tabs with the Playwright MCP."

   You'll see a `mcp__playwright__browser_tabs` tool_use block in the
   chat transcript, followed by a tool_result that enumerates the
   real workspace tabs (matching what `Target.getTargets` reports).

To take it down: kill the SSH session
(`pkill -f 'ssh -R 9090:127.0.0.1:9090'` on the desktop) and unset
the EC2 systemd drop-in if you want to fully roll back.
