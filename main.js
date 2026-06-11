'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { TabManager, TAB_SCROLLBAR_CSS } = require('./tab-manager');
const mcpServer = require('./mcp-server');
const { TunnelManager } = require('./tunnel-manager');
const { VisualEdit } = require('./visual-edit');

// Log to a writable location. In a packaged app __dirname lives inside the
// read-only app.asar, so writing debug.log there throws ENOENT and crashes the
// app on the very first dbg() call. userData is always writable. Logging must
// never be fatal, so swallow any error.
const DBG = path.join(app.getPath('userData'), 'debug.log');
let dbgDirReady = false;
const dbg = (...args) => {
  try {
    if (!dbgDirReady) {
      fs.mkdirSync(path.dirname(DBG), { recursive: true });
      dbgDirReady = true;
    }
    fs.appendFileSync(DBG, `[${new Date().toISOString()}] ${args.join(' ')}\n`);
  } catch { /* never let logging crash the app */ }
};

// App icon shown in the taskbar / window chrome (dev + packaged). Windows
// prefers the .ico; everywhere else the PNG renders fine.
const APP_ICON = path.join(
  __dirname,
  'assets',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

// Pro tab-strip + toolbar restyle, injected into the (remotely-served)
// workspace UI from the desktop shell so it applies without a frontend
// redeploy. Uses !important to win over the shipped globals.css. Mirrors the
// source-of-truth rules in frontend/src/app/globals.css. The active tab and
// the selected toolbar tool both adopt the AI-bot accent (var(--bot-accent),
// defined on :root by the app); a sparkle marks the active tab's left edge;
// the close (×) shows on hover only; the + button gets a modern hover.
// AI-bot mascot head (antenna + rounded head + two eye holes via evenodd) —
// matches MiniBot. Used as the active-tab left-edge marker.
const BOT_HEAD_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' fill-rule='evenodd' d='M8 6H16a4 4 0 0 1 4 4V15a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4ZM10.5 2.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0ZM11.3 4H12.7V6H11.3ZM7.6 12a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0ZM13 12a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0Z'/%3E%3C/svg%3E\") center / contain no-repeat";
const CHROME_THEME_CSS = `
  .editor-tab {
    gap: 7px !important;
    padding: 0 8px 0 12px !important;
    transition: background 140ms ease, color 140ms ease !important;
  }
  .editor-tab:not(.active):hover {
    background: var(--vsc-hover) !important;
    color: var(--vsc-text) !important;
  }
  .editor-tab.active {
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--bot-accent) 26%, var(--vsc-bg)),
      color-mix(in srgb, var(--bot-accent) 12%, var(--vsc-bg))) !important;
    color: var(--vsc-text-emphasis) !important;
    box-shadow:
      inset 0 2px 0 var(--bot-accent),
      inset 1px 0 0 color-mix(in srgb, var(--bot-accent) 40%, var(--vsc-border-strong)),
      inset -1px 0 0 color-mix(in srgb, var(--bot-accent) 40%, var(--vsc-border-strong)) !important;
  }
  .editor-tab.active::before {
    content: "" !important;
    flex: 0 0 auto !important;
    width: 14px !important;
    height: 14px !important;
    background-color: var(--bot-accent) !important;
    -webkit-mask: ${BOT_HEAD_MASK} !important;
    mask: ${BOT_HEAD_MASK} !important;
    filter: drop-shadow(0 0 3px var(--bot-accent-glow)) !important;
  }
  .editor-tab:hover .tab-close,
  .editor-tab:focus-within .tab-close { opacity: 1 !important; }
  .editor-tab.active .tab-close { opacity: 0 !important; }
  .editor-tab.active:hover .tab-close,
  .editor-tab.active:focus-within .tab-close { opacity: 1 !important; }
  .tab-close:hover {
    background: color-mix(in srgb, var(--vsc-error) 22%, transparent) !important;
    color: var(--vsc-error) !important;
  }
  .tab-add {
    width: 28px !important;
    height: 28px !important;
    margin: 0 4px !important;
    align-self: center !important;
    border-radius: 7px !important;
    font-size: 18px !important;
    line-height: 1 !important;
    color: var(--vsc-text-muted) !important;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease !important;
  }
  .tab-add svg { width: 15px !important; height: 15px !important; }
  .tab-add:hover {
    background: var(--bot-accent-soft) !important;
    color: var(--bot-accent) !important;
    transform: scale(1.08) !important;
  }
  .tab-add:active { transform: scale(0.94) !important; }
  .overlay-toolbar-btn.active {
    background: var(--bot-accent-soft) !important;
    color: var(--bot-accent) !important;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bot-accent) 55%, transparent) !important;
  }
  .overlay-toolbar-btn.active:hover {
    background: color-mix(in srgb, var(--bot-accent) 32%, transparent) !important;
    color: var(--vsc-text-emphasis) !important;
  }
  /* Profile avatar: pin the editor-toolbar one to the far-left of the
     window and drop the duplicate one in the chat-session tab strip. */
  .editor-overlay-toolbar .profile-avatar-btn {
    position: fixed !important;
    left: 8px !important;
    top: 4px !important;
    z-index: 99999 !important;
    order: -1 !important;
    margin: 0 !important;
  }
  .chat-session-tabs .profile-avatar-btn { display: none !important; }
`;

// Shell-side enhancements injected into the (remotely-served) workspace
// document on every load. Three pieces, all idempotent via window flags:
//
//  1. Shell-ready signal — tells the main process (which is showing the
//     animated-bot loading splash window) that the workspace UI has
//     mounted, so the splash can drop and the real window appear. The
//     user never sees the remote frontend's plain "Loading workspace…".
//  2. Profile-dropdown coordinator. Native WebContentsView tabs always
//     paint above the main-window DOM, so the .profile-dropdown (a main-
//     shell overlay) gets covered on any tab with live content. We DON'T
//     shift or blank the tab: on open we paint a frozen screenshot of the
//     tab (via tab.capture) at the same bounds and hide the live view, so
//     the dropdown overlays cleanly; on close we drop the image and show
//     the view again.
//  3. Logout wiring: the .profile-dropdown-item.logout button drives the
//     animated desktop disconnect (app:disconnect → shutdown splash →
//     back to connect screen).
const SHELL_ENHANCEMENTS_JS = `(() => {
  const api = window.__AIIDE__ && window.__AIIDE__.tab;
  const appApi = window.__AIIDE__ && window.__AIIDE__.app;

  // ── 1. Signal shell-ready so the loading splash can drop ──────────
  if (!window.__aiideShellReadySignalled) {
    const fire = () => {
      if (window.__aiideShellReadySignalled) return true;
      if (document.querySelector('.editor-overlay-toolbar') ||
          document.querySelector('.chat-session-tabs')) {
        window.__aiideShellReadySignalled = true;
        try { appApi && appApi.shellReady(); } catch (e) {}
        return true;
      }
      return false;
    };
    if (!fire()) {
      const poll = setInterval(() => { if (fire()) clearInterval(poll); }, 150);
      setTimeout(() => clearInterval(poll), 30000);
    }
  }

  if (!api) return;

  // ── 2. Profile-dropdown coordinator (frozen screenshot, no shift) ──
  if (!window.__aiideProfileDropdownFix) {
    window.__aiideProfileDropdownFix = true;
    let frozen = null; // { tabId, el }
    const restore = () => {
      if (!frozen) return;
      const f = frozen; frozen = null;
      try { if (f.el && f.el.parentNode) f.el.remove(); } catch (e) {}
      try { api.setVisible(f.tabId, true); } catch (e) {}
    };
    const apply = () => {
      if (frozen) return;
      if (!document.querySelector('.profile-dropdown')) return;
      Promise.resolve(api.list()).then((info) => {
        const id = info && info.activeTabId;
        if (id == null) return;
        const t = (info.tabs || []).find((x) => x.tabId === id);
        const b = t && t.bounds;
        if (!b || !document.querySelector('.profile-dropdown')) return;
        return Promise.resolve(api.capture(id)).then((cap) => {
          if (frozen || !cap || !cap.dataUrl) return;
          if (!document.querySelector('.profile-dropdown')) return;
          const img = document.createElement('div');
          img.id = 'aiide-tab-freeze';
          img.style.cssText = 'position:fixed;left:' + b.x + 'px;top:' + b.y +
            'px;width:' + b.width + 'px;height:' + b.height + 'px;z-index:8000;' +
            'background:center/cover no-repeat #0a0a0a;pointer-events:none;' +
            'background-image:url(' + cap.dataUrl + ')';
          document.body.appendChild(img);
          frozen = { tabId: id, el: img };
          try { api.setVisible(id, false); } catch (e) { restore(); }
        });
      }).catch(() => {});
    };
    const obs = new MutationObserver(() => {
      if (document.querySelector('.profile-dropdown')) apply(); else restore();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── 3. Logout → animated desktop disconnect ───────────────────────
  if (appApi && !window.__aiideLogoutWired) {
    window.__aiideLogoutWired = true;
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('.profile-dropdown-item.logout');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      try { appApi.disconnect(); } catch (err) {}
    }, true);
  }
})();`;

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
  // Dev mode: register via node + start.js so ELECTRON_RUN_AS_NODE is
  // stripped before Electron starts. Registering electron.exe directly
  // inherits the VS Code / Claude Code shell env where
  // ELECTRON_RUN_AS_NODE=1, which puts Electron in Node.js mode and
  // silently breaks the second-instance deep-link handoff.
  const nodeExe = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, '..', 'Programs', 'nodejs', 'node.exe')
    : null;
  const startScript = path.join(__dirname, 'start.js');
  // Prefer the node.exe that's already in PATH (most reliable).
  const nodeBin = (() => {
    try {
      const { execSync } = require('child_process');
      const out = execSync('where node', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split('\n')[0].trim();
    } catch {
      return nodeExe;
    }
  })();
  if (nodeBin) {
    app.setAsDefaultProtocolClient('aiide', nodeBin, [startScript]);
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

// Visual-edit platform tool. Attaches a CDP debugger to a tab's
// WebContentsView to drive the live picker + inspector preview agent, and
// builds the agent task (target screenshot + per-pin annotation deltas).
// Registers the `visual-edit:*` IPC surface on construction.
const visualEdit = new VisualEdit({
  getOwnerWindow: () => mainWindow,
  getWebContents: (tabId) => tabManager.getWebContents(tabId),
  dbg,
});

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
    title: 'AI Workspace — Connect',
    icon: APP_ICON,
    show: false,
  });

  connectWindow.loadFile(path.join(__dirname, 'connect.html'));
  const showConnect = () => { if (connectWindow && !connectWindow.isDestroyed()) connectWindow.show(); };
  connectWindow.once('ready-to-show', showConnect);
  setTimeout(showConnect, 3000);
  connectWindow.on('closed', () => { connectWindow = null; });
  // No application menu on the connect window â€” it's a modal-style dialog.
  connectWindow.setMenu(null);
}

// â”€â”€ Loading / shutdown splash â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A frameless, always-on-top window rendering the animated bot (loading.html).
// Sits over the main window's spot during workspace load (so the remote
// "Loading workspace…" text is never seen) and during logout (mode=shutdown
// plays a power-down animation so the shutdown is obvious).

let splashWindow = null;

function showSplashWindow(bounds, mode) {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) { return; }
    const b = bounds || {};
    splashWindow = new BrowserWindow({
      x: b.x, y: b.y,
      width: b.width || 1440,
      height: b.height || 900,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      backgroundColor: '#0b0a0f',
      title: 'AI Workspace',
      icon: APP_ICON,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    splashWindow.loadFile(path.join(__dirname, 'loading.html'),
      mode === 'shutdown' ? { search: 'mode=shutdown' } : undefined);
    splashWindow.once('ready-to-show', () => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.showInactive();
    });
    splashWindow.on('closed', () => { splashWindow = null; });
  } catch (e) { dbg('showSplashWindow failed: ' + e.message); }
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.close(); } catch { /* already gone */ }
  }
  splashWindow = null;
}

// Animated logout: power-down splash, then tear down the session.
function logoutWithAnimation() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showSplashWindow(mainWindow.getBounds(), 'shutdown');
    setTimeout(() => { disconnectWorkspace(); closeSplashWindow(); }, 1400);
  } else {
    disconnectWorkspace();
  }
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
    title: 'AI Workspace',
    icon: APP_ICON,
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
    if (isMainFrame && !isSameDocument) {
      tabManager.destroyAll();
      // Reload/re-sign-in: cover the reloading shell (and its "Loading
      // workspace…" text) with the bot splash until shell-ready re-fires.
      if (mainWindow && !mainWindow.isDestroyed()) showSplashWindow(mainWindow.getBounds());
    }
  });

  // Hijack guard. The main window hosts the workspace shell and must NEVER be
  // navigated away from the workspace origin. A link/button inside the page
  // that targets the top frame (instead of window.open, which the handler
  // below catches) would otherwise replace the ENTIRE UI with that site and —
  // via the orphan-view guard above — tear down every tab. Observed in the
  // wild: a click sent the whole window to an external marketing page, leaving
  // "nothing else" loading. Block any cross-origin top-level navigation and
  // route it into a workspace tab instead, exactly like a popup. Same-origin
  // navigations (the SPA navigating within itself, auth redirects on the
  // workspace host) pass through. loadURL()/reload()/back-forward don't fire
  // will-navigate, so our own programmatic loads are unaffected.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (/^(about|chrome|devtools|data):/.test(url)) return;
    const home = readConfig().workspaceUrl || mainWindow.webContents.getURL();
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === new URL(home).origin; } catch { /* keep false */ }
    if (sameOrigin) return;
    event.preventDefault();
    dbg('will-navigate blocked top-level main-window nav to ' + url + ' — routing to tab');
    const label = (() => { try { return new URL(url).hostname || url; } catch { return url; } })();
    mainWindow.webContents.send('open-tab', { url, label });
  });

  // Force our chrome theme onto the remotely-served workspace UI: themed
  // scrollbars + the pro tab-strip/toolbar restyle (AI-bot accent on the
  // active tab & selected tool, hover-only close, modern + button). Done
  // from the shell so it lands immediately without redeploying the frontend.
  // Re-applied on every DOM load because insertCSS only sticks per-document.
  mainWindow.webContents.on('dom-ready', () => {
    const wc = mainWindow?.webContents;
    if (!wc) return;
    wc.insertCSS(TAB_SCROLLBAR_CSS).catch((err) =>
      dbg('insertCSS main scrollbar failed: ' + err.message)
    );
    wc.insertCSS(CHROME_THEME_CSS).catch((err) =>
      dbg('insertCSS chrome theme failed: ' + err.message)
    );
    wc.executeJavaScript(SHELL_ENHANCEMENTS_JS, true).catch((err) =>
      dbg('shell enhancements inject failed: ' + err.message)
    );
  });

  // Animated-bot loading splash. A frameless window sits over the main
  // window's spot until the workspace SHELL is ready (the injected poller
  // fires 'workspace:shell-ready' via __AIIDE__.app.shellReady()), so the
  // user never sees the remote frontend's plain "Loading workspace…" text
  // — only our bot. ready-to-show fires at first paint (= that text), so we
  // deliberately do NOT reveal the main window there; the global
  // 'workspace:shell-ready' handler (registered once below) does.
  showSplashWindow(mainWindow.getBounds());
  mainWindow.loadURL(workspaceUrl);
  setTimeout(() => { // hard fallback if the shell never signals ready
    closeSplashWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  }, 25000);

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
    void visualEdit.destroyAll();
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

// â”€â”€ Disconnect / logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Single source of truth for tearing down the workspace session and
// returning to the connect screen. Used by the File ▸ Disconnect menu,
// the Ctrl+Shift+D accelerator, and the profile-dropdown Logout button
// (via the app:disconnect IPC).

function disconnectWorkspace() {
  // Phase 6 — kill the tunnel + drop the bearer token before we wipe the
  // workspace URL. Otherwise the next launch would try to spin a tunnel
  // against the prior user's EC2 with their (no-longer-valid) token.
  void tunnelManager.stop();
  clearConfig();
  if (mainWindow) { mainWindow.close(); }
  createConnectWindow();
}

ipcMain.handle('app:disconnect', () => { logoutWithAnimation(); });

// Injected shell poller fires this once the workspace UI has mounted. Close
// the loading splash and reveal the main window (first load) — on reloads
// the main window is already visible, so this just drops the splash.
ipcMain.on('workspace:shell-ready', () => {
  closeSplashWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
});

// â”€â”€ Application menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Disconnect Workspace',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+D' : 'Ctrl+Shift+D',
          click() { logoutWithAnimation(); },
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
  await visualEdit.destroyAll().catch(() => {});
  tabManager.destroyAll();
  await tunnelManager.stop().catch(() => {});
  if (mcpEnabled) await mcpServer.stop({ dbg }).catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

