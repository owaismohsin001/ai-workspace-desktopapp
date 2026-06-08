'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { TabManager } = require('./tab-manager');
const mcpServer = require('./mcp-server');
const { TunnelManager } = require('./tunnel-manager');

const DBG = path.join(__dirname, 'debug.log');
const dbg = (...args) => fs.appendFileSync(DBG, `[${new Date().toISOString()}] ${args.join(' ')}\n`);

// Hosts that actively detect + refuse iframe embedding (payment, OAuth, banks).
// These open in their own BrowserWindow instead of a workspace tab.
const STANDALONE_HOST_SUFFIXES = [
  'checkout.stripe.com', 'stripe.com',
  'checkout.razorpay.com', 'secure.payu.in', 'paypal.com',
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com',
  'auth0.com', 'plaid.com',
];

function isPaymentUrl(url) {
  try {
    const host = new URL(url).hostname;
    return STANDALONE_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s) || host.endsWith(s));
  } catch {
    return false;
  }
}

// Platform landing-page URL.  Set PLATFORM_URL in the shell (or a .env
// loader) to point at your own deployment.
const PLATFORM_URL = process.env.PLATFORM_URL ?? 'https://platform.example.com';

// â”€â”€ Config helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Workspace URL is persisted in userData/config.json so the app reconnects
// automatically on the next launch without going through the auth flow again.

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const current = readConfig();
  fs.writeFileSync(configPath(), JSON.stringify({ ...current, ...patch }, null, 2));
}

function clearConfig() {
  try { fs.unlinkSync(configPath()); } catch { /* already gone */ }
}

// â”€â”€ Protocol registration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Register aiide:// BEFORE app is ready, as required by Electron.
// On macOS the OS fires the open-url event; on Windows/Linux a second
// instance is spawned with the URL as a CLI argument (handled below).

if (process.defaultApp) {
  // Running as "electron ." (dev mode) â€” bind to the current script path
  // so the protocol works without a packaged binary.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('aiide', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('aiide');
}

// â”€â”€ Single-instance lock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Windows/Linux: when the user clicks aiide:// in the browser, the OS
// spawns a second Electron instance with the URL in argv.  We grab the
// lock so only one instance ever runs; the second instance hands its
// argv to the first via the second-instance event and immediately quits.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Remote debugging port (Phase 0: Playwright MCP prep) ───────────────────
// CDP endpoint used to enumerate top-level page targets and drive
// WebContentsView tabs through playwright-core's connectOverCDP. ON by
// default at 9222; set AIIDE_CDP_PORT to override or to 0 to disable.
// Bound to 127.0.0.1 so the port is never reachable off-box.
const cdpPort = Number.parseInt(process.env.AIIDE_CDP_PORT ?? '9222', 10);
if (Number.isFinite(cdpPort) && cdpPort > 0 && cdpPort < 65536) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  dbg('remote-debugging-port enabled on 127.0.0.1:' + cdpPort);
}

// ── Playwright MCP server (Phase 3) ────────────────────────────────────
// ON by default at 9090; set AIIDE_MCP_PORT to override or to 0 to disable.
// Requires CDP to be enabled (defaulted above) — the MCP server attaches
// to our own CDP endpoint via connectOverCDP. Bound to 127.0.0.1 only.
// Started after `app.whenReady()` because @playwright/mcp lazily loads
// playwright-core, which expects to be in a real Node event loop with no
// Electron startup races.
const mcpPort = Number.parseInt(process.env.AIIDE_MCP_PORT ?? '9090', 10);
const mcpEnabled = Number.isFinite(mcpPort) && mcpPort > 0 && mcpPort < 65536;

// â”€â”€ Window handles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let mainWindow = null;
let connectWindow = null;

// One TabManager for the app lifetime. The owner window can come and go
// (sign-out → reconnect creates a new BrowserWindow); rebindToWindow() keeps
// the existing WebContentsView children attached to whichever window is live.
const tabManager = new TabManager(() => mainWindow, dbg);

// Phase 6 — automated reverse SSH tunnel to the user's EC2 workspace.
// Started after a successful sign-in (deep link or restored config),
// stopped on sign-out / app quit. Token + platformUrl are read from
// config.json; refreshes get written back via setToken.
const tunnelManager = new TunnelManager({
  getToken: () => readConfig().desktopToken ?? null,
  setToken: (t) => writeConfig({ desktopToken: t }),
  getPlatformUrl: () => readConfig().platformUrl ?? PLATFORM_URL,
  dbg,
});
tunnelManager.on('status', (s) => {
  dbg(`tunnel-manager status=${s.status} ${s.error ? '(' + s.error + ')' : ''}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tunnel:status', s);
  }
});
ipcMain.handle('tunnel:getStatus', () => tunnelManager.status());

// â”€â”€ Connect window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function createConnectWindow() {
  if (connectWindow) { connectWindow.focus(); return; }

  connectWindow = new BrowserWindow({
    width: 460,
    height: 600,
    resizable: false,
    backgroundColor: '#080808',
    webPreferences: {
      preload: path.join(__dirname, 'preload-connect.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'AI IDE Studio â€” Connect',
    show: false,
  });

  connectWindow.loadFile(path.join(__dirname, 'connect.html'));
  connectWindow.once('ready-to-show', () => connectWindow.show());
  connectWindow.on('closed', () => { connectWindow = null; });
  // No application menu on the connect window â€” it's a modal-style dialog.
  connectWindow.setMenu(null);
}

// â”€â”€ Main workspace window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function createMainWindow(workspaceUrl) {
  if (mainWindow) {
    mainWindow.loadURL(workspaceUrl);
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'AI IDE Studio',
    show: false,
  });

  // Phase 1.2 — orphan-view guard. Every full-page navigation in the
  // renderer (F5, Playwright reload, deep-link re-sign-in, programmatic
  // location change) tears down the React tree and re-runs tab.open with
  // fresh tabIds, leaving the previous views orphaned at stale bounds
  // (visually they cover the tab strip and toolbar). Destroy everything
  // on every real navigation. isSameDocument filters out SPA route
  // changes inside the workspace shell — those keep their views.
  // Attached before loadURL so it catches the initial nav too; the initial
  // call is a harmless no-op because the registry is empty.
  mainWindow.webContents.on('did-start-navigation', (_e, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) tabManager.destroyAll();
  });

  mainWindow.loadURL(workspaceUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Desktop-app window-open policy:
  //   Internal URLs (about:, chrome:, devtools:) → drop silently.
  //   Everything else → let Electron create a native BrowserWindow.
  //
  // Why allow everything? window.open() without explicit size features reports
  // disposition:'foreground-tab' in Electron — indistinguishable from a plain
  // link click. Stripe checkout, OAuth screens, and other managed popups all
  // use this form. Sending them to shell.openExternal() causes window.open()
  // to return null and the page shows "browser blocked the popup". In a desktop
  // app every new window should be a native window — the user manages them like
  // any other app window.
  mainWindow.webContents.setWindowOpenHandler(({ url, disposition, frameName }) => {
    dbg('setWindowOpenHandler url=' + url + ' disposition=' + disposition + ' frame=' + frameName);
    if (/^(chrome|devtools):/.test(url)) {
      return { action: 'deny' };
    }
    // Create the popup hidden — did-create-window will intercept the real URL
    // it navigates to and route it into the workspace tab system instead.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { show: false },
    };
  });

  // Every popup created above starts hidden. When it navigates to the real
  // URL, route it: payment/checkout flows → new BrowserWindow (they actively
  // detect and refuse iframe embedding even with headers stripped); everything
  // else → workspace tab via IPC.
  mainWindow.webContents.on('did-create-window', (newWin) => {
    const route = (event, url) => {
      if (url === 'about:blank') return;
      if (event?.preventDefault) event.preventDefault();
      dbg('did-create-window route url=' + url);
      setImmediate(() => { if (!newWin.isDestroyed()) newWin.close(); });

      if (isPaymentUrl(url)) {
        // Payment processors (Stripe, PayPal, etc.) use JS-based iframe detection
        // and refuse to operate when embedded — open as a proper window.
        dbg('payment url -> BrowserWindow');
        const payWin = new BrowserWindow({
          width: 560,
          height: 780,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        payWin.loadURL(url);
      } else {
        // Regular popup → workspace tab
        const label = (() => { try { return new URL(url).hostname || url; } catch { return url; } })();
        mainWindow?.webContents.send('open-tab', { url, label });
      }
    };

    newWin.webContents.on('will-navigate', (event, url) => route(event, url));
    newWin.webContents.once('did-navigate', (e, url) => route(null, url));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Sign-out → reconnect creates a fresh window/renderer; any surviving
    // views would orphan into the new session. Tear them down.
    tabManager.destroyAll();
  });
  buildAppMenu();
}

// â”€â”€ Deep-link handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Parses aiide://workspace?url=<encoded>&name=<encoded> and transitions
// from the connect window to the workspace window.

function handleDeepLink(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return; }

  if (parsed.protocol !== 'aiide:') return;
  if (parsed.hostname !== 'workspace') return;

  const workspaceUrl = parsed.searchParams.get('url');
  if (!workspaceUrl || !workspaceUrl.startsWith('http')) return;

  // Phase 6 — capture the desktop bearer token + platform URL the
  // landing page minted. Both are optional in the deep link so legacy
  // /desktop/auth pages (without the Phase 6 patch) still work — they
  // just can't drive the automated tunnel.
  const desktopToken = parsed.searchParams.get('token') ?? undefined;
  const platformUrl = parsed.searchParams.get('platformUrl') ?? undefined;

  writeConfig({
    workspaceUrl,
    connectedAt: new Date().toISOString(),
    ...(desktopToken ? { desktopToken } : {}),
    ...(platformUrl ? { platformUrl } : {}),
  });

  if (connectWindow) {
    connectWindow.close();   // triggers the 'closed' handler which nulls it
  }
  createMainWindow(workspaceUrl);
  // Kick off the tunnel if we have everything we need.
  if (desktopToken || readConfig().desktopToken) {
    tunnelManager.start();
  }
}

// â”€â”€ Application menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Disconnect Workspace',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+D' : 'Ctrl+Shift+D',
          click() {
            // Phase 6 — kill the tunnel + drop the bearer token before we
            // wipe the workspace URL. Otherwise the next launch would try
            // to spin a tunnel against the prior user's EC2 with their
            // (no-longer-valid) token.
            void tunnelManager.stop();
            clearConfig();
            if (mainWindow) { mainWindow.close(); }
            createConnectWindow();
          },
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Developer',
      submenu: [
        { role: 'toggleDevTools' },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({ label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// â”€â”€ IPC handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Connect window: "Sign in with Platform" button opens the platform's
// /desktop/auth page in the system browser.
ipcMain.handle('open-platform-browser', (_, platformUrl) => {
  const base = (platformUrl || PLATFORM_URL).replace(/\/$/, '');
  shell.openExternal(`${base}/desktop/auth`);
});

// Connect window: manual workspace URL entry (no OAuth required).
ipcMain.handle('connect-manual', (_, workspaceUrl) => {
  if (!workspaceUrl || !/^https?:\/\//.test(workspaceUrl)) {
    return { error: 'Enter a valid http:// or https:// URL.' };
  }
  writeConfig({ workspaceUrl, connectedAt: new Date().toISOString() });
  if (connectWindow) { connectWindow.close(); }
  createMainWindow(workspaceUrl);
  return { ok: true };
});

// Expose the configured PLATFORM_URL so connect.html can pre-fill it.
ipcMain.handle('get-config', () => ({
  platformUrl: PLATFORM_URL,
}));

// â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Windows / Linux: second instance carries the aiide:// URL in its argv.
app.on('second-instance', (event, argv) => {
  const deepLink = argv.find((a) => a.startsWith('aiide://'));
  if (deepLink) handleDeepLink(deepLink);

  // Bring whichever window is open to the front.
  const win = mainWindow ?? connectWindow;
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

// macOS: OS delivers deep links via open-url after the app is already running.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.whenReady().then(() => {
  dbg('app ready');

  // Strip embedding-restriction headers from every response so any URL
  // (Stripe checkout, OAuth screens, etc.) can load inside workspace tabs
  // without hitting X-Frame-Options / CSP frame-ancestors blocks.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lk = key.toLowerCase();
      if (lk === 'x-frame-options') {
        delete headers[key];
      } else if (lk === 'content-security-policy') {
        headers[key] = headers[key].map(
          (csp) => csp.replace(/\bframe-ancestors\b[^;]*(;|$)\s*/gi, '')
        );
      }
    }
    callback({ responseHeaders: headers });
  });
  // Also check argv on first launch (macOS doesn't use second-instance for
  // the initial open-url before the app is ready â€” but the URL can appear in
  // argv[1] on some platforms when the app is launched via a protocol link).
  const firstLaunchUrl = process.argv.find((a) => a.startsWith('aiide://'));
  if (firstLaunchUrl) {
    handleDeepLink(firstLaunchUrl);
    return;
  }

  const { workspaceUrl, desktopToken } = readConfig();
  if (workspaceUrl) {
    createMainWindow(workspaceUrl);
    // Phase 6 — restored session: re-open the tunnel automatically. If the
    // token has expired the manager will emit a `token-expired` event and
    // fall idle until the user re-signs-in.
    if (desktopToken) tunnelManager.start();
  } else {
    createConnectWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const { workspaceUrl } = readConfig();
      if (workspaceUrl) createMainWindow(workspaceUrl);
      else createConnectWindow();
    }
  });

  // Phase 3 — start the Playwright MCP server once the window/views machinery
  // is set up. Failure is logged but non-fatal: the workspace still works
  // without the MCP endpoint.
  if (mcpEnabled) {
    mcpServer.start({ mcpPort, cdpPort, dbg })
      .catch((err) => dbg('mcp-server start failed: ' + (err?.stack ?? err)));
  }
});

app.on('window-all-closed', async () => {
  // Drop every WebContentsView so we don't leak page targets past shutdown.
  tabManager.destroyAll();
  await tunnelManager.stop().catch(() => {});
  if (mcpEnabled) await mcpServer.stop({ dbg }).catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

