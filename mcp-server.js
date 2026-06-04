'use strict';

// Phase 3 → Phase 4: in-process Playwright MCP server.
//
// Loads @playwright/mcp's createConnection() pointed at our own CDP endpoint
// (AIIDE_CDP_PORT, loopback). Exposes the resulting MCP Server(s) over
// Streamable HTTP on AIIDE_MCP_PORT, also bound to loopback.
//
// Phase 4 multi-session:
//   • One MCP `Server` per HTTP session, routed by the standard
//     `mcp-session-id` header. The first POST without a session must be an
//     `initialize`; the transport's `sessionIdGenerator` assigns an ID,
//     which the client then reuses for every subsequent POST/GET/DELETE.
//   • `sharedBrowserContext: true` in the @playwright/mcp config so all
//     sessions reuse one Playwright BrowserContext (one connectOverCDP to
//     our Electron, not N).
//
// Auth: intentionally NONE per the Phase 4 plan call this session
// (loopback-only + SSH-tunnel access path). Add a bearer-token middleware
// here if that policy changes.
//
// Gated entirely behind AIIDE_MCP_PORT. Default off; if it's not set, we
// don't import @playwright/mcp at all so the Electron app stays fast/cheap
// to start in normal use.

const http = require('node:http');

let activeCapabilities = null;
let activeCdpPort = null;
let activeDbg = () => {};
let httpServer = null;
let createConnectionFn = null;     // resolved from @playwright/mcp
let StreamableHTTPServerTransport = null; // resolved from @modelcontextprotocol/sdk
let randomUUIDFn = null;

/** @type {Map<string, { server: any, transport: any }>} */
const sessions = new Map();

async function start({ mcpPort, cdpPort, dbg }) {
  if (!mcpPort) return null;
  if (!cdpPort) {
    dbg('mcp-server: AIIDE_MCP_PORT set but AIIDE_CDP_PORT is not; refusing to start');
    return null;
  }

  // Lazy require so the cost is only paid when MCP is enabled. The package
  // pulls in playwright-core which is multi-MB; non-MCP runs should never
  // import it.
  ({ createConnection: createConnectionFn } = require('@playwright/mcp'));
  ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  ({ randomUUID: randomUUIDFn } = require('node:crypto'));

  // Capability list intentionally broad — full official tool set minus the
  // browser-installer (irrelevant for an attached Electron) and self-
  // configuration tools.
  activeCapabilities = [
    'core', 'core-navigation', 'core-tabs', 'core-input',
    'network', 'pdf', 'vision', 'devtools',
  ];
  activeCdpPort = cdpPort;
  activeDbg = dbg ?? (() => {});

  httpServer = http.createServer(handleRequest);
  await new Promise((resolve) => httpServer.listen(mcpPort, '127.0.0.1', resolve));
  dbg(`mcp-server: listening on http://127.0.0.1:${mcpPort}/  (CDP=${cdpPort})`);
  return { mcpPort };
}

async function stop({ dbg } = {}) {
  for (const { transport, server } of sessions.values()) {
    try { transport.close?.(); } catch (err) { dbg?.('mcp-server: transport close: ' + err.message); }
    try { server.close?.(); } catch (err) { dbg?.('mcp-server: server close: ' + err.message); }
  }
  sessions.clear();
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(() => resolve()));
    httpServer = null;
  }
}

/* ── http handler ──────────────────────────────────────────────────── */

async function handleRequest(req, res) {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST') {
      const body = await readJson(req);

      let entry = sessionId ? sessions.get(sessionId) : null;
      if (!entry) {
        if (!isInitRequest(body)) {
          respondJsonRpc(res, 400, {
            jsonrpc: '2.0', error: { code: -32600, message: 'Missing or invalid session ID' }, id: extractId(body),
          });
          return;
        }
        // Fresh client — spawn a new MCP server + transport pair for it.
        entry = await spawnSession();
      }

      await entry.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId) {
        respondJsonRpc(res, 400, {
          jsonrpc: '2.0', error: { code: -32600, message: 'Missing session ID' }, id: null,
        });
        return;
      }
      const entry = sessions.get(sessionId);
      if (!entry) {
        respondJsonRpc(res, 404, {
          jsonrpc: '2.0', error: { code: -32601, message: 'Unknown session' }, id: null,
        });
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405).end();
  } catch (err) {
    activeDbg('mcp-server: handleRequest error: ' + (err?.stack ?? err));
    if (!res.headersSent) {
      respondJsonRpc(res, 500, {
        jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null,
      });
    }
  }
}

async function spawnSession() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUIDFn(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, entry);
      activeDbg(`mcp-server: session opened ${sid} (active=${sessions.size})`);
    },
  });

  const server = await createConnectionFn({
    browser: { cdpEndpoint: `http://127.0.0.1:${activeCdpPort}` },
    capabilities: activeCapabilities,
    sharedBrowserContext: true,
  });

  const entry = { server, transport };

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.delete(sid);
    activeDbg(`mcp-server: session closed ${sid ?? '<pre-init>'} (active=${sessions.size})`);
    server.close?.()?.catch?.(() => {});
  };

  await server.connect(transport);
  return entry;
}

/* ── helpers ───────────────────────────────────────────────────────── */

function isInitRequest(body) {
  if (!body) return false;
  if (Array.isArray(body)) return body.some((m) => m?.method === 'initialize');
  return body?.method === 'initialize';
}

function extractId(body) {
  if (!body) return null;
  if (Array.isArray(body)) return body[0]?.id ?? null;
  return body?.id ?? null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function respondJsonRpc(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

module.exports = { start, stop };
