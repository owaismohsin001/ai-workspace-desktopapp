'use strict';

// One WebContentsView per workspace tab. Each view is a top-level WebContents
// from CDP's perspective, so it shows up as type:"page" — that's the whole
// point of the migration. The renderer (workspace-shell.tsx) stays
// authoritative for tab metadata (id, label, url, order, groups); main owns
// only the view lifecycle + bounds + visibility.

const { BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');

// Hosts that actively detect + refuse iframe embedding (payment, OAuth, banks).
// Preserved from the pre-migration popup policy in main.js — these still get
// their own BrowserWindow when a tab's window.open() targets them.
const STANDALONE_HOST_SUFFIXES = [
  'checkout.stripe.com', 'stripe.com',
  'checkout.razorpay.com', 'secure.payu.in', 'paypal.com',
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com',
  'auth0.com', 'plaid.com',
];

function isPaymentUrl(url) {
  try {
    const host = new URL(url).hostname;
    return STANDALONE_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} TabEntry
 * @property {WebContentsView} view
 * @property {boolean} visible
 * @property {{x:number,y:number,width:number,height:number}|null} lastBounds
 */

class TabManager {
  /**
   * @param {() => BrowserWindow | null} getOwnerWindow  Lazy accessor — the main
   *     window may not exist yet when TabManager is constructed (and can be
   *     destroyed/recreated). Resolved on each call.
   * @param {(...args: any[]) => void} dbg               Existing main-process logger.
   */
  constructor(getOwnerWindow, dbg) {
    /** @type {Map<string, TabEntry>} */
    this.tabs = new Map();
    /** The renderer's authoritative active tabId. Updated via tab:setActive
     *  IPC on every UI tab switch (Phase 5 — see workspace-shell.tsx). null
     *  on app start until the first switch lands. Exposed to MCP-side
     *  callers via tab:list so they can default tool actions to "current
     *  UI tab" without having to scrape the DOM. */
    this.activeTabId = null;
    this.getOwnerWindow = getOwnerWindow;
    this.dbg = dbg ?? (() => {});
    this._registerIpc();
  }

  /** Ensure the active main window has every existing view attached. Called
   *  when a brand-new main window replaces an old one (sign-out → reconnect).
   *  Views are kept alive across that transition so the renderer's tab state
   *  stays consistent — only the host BrowserWindow changes. */
  rebindToWindow(win) {
    if (!win || win.isDestroyed()) return;
    for (const { view } of this.tabs.values()) {
      try {
        if (!win.contentView.children.includes(view)) {
          win.contentView.addChildView(view);
        }
      } catch (err) {
        this.dbg('rebindToWindow: addChildView failed: ' + err.message);
      }
    }
  }

  /** Destroy every view. Called on window-all-closed so we don't leak
   *  WebContents past app shutdown on macOS. */
  destroyAll() {
    for (const tabId of Array.from(this.tabs.keys())) this._destroy(tabId);
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  _registerIpc() {
    ipcMain.handle('tab:open', (_e, { tabId, url }) => this._open(tabId, url));
    ipcMain.handle('tab:close', (_e, { tabId }) => this._destroy(tabId));
    ipcMain.handle('tab:navigate', (_e, { tabId, url }) => this._navigate(tabId, url));
    ipcMain.handle('tab:reload', (_e, { tabId }) => this._reload(tabId));
    ipcMain.handle('tab:setVisible', (_e, { tabId, visible }) => this._setVisible(tabId, visible));
    ipcMain.handle('tab:setBounds', (_e, { tabId, rect }) => this._setBounds(tabId, rect));
    ipcMain.handle('tab:capture', (_e, { tabId }) => this._capture(tabId));
    ipcMain.handle('tab:setActive', (_e, { tabId }) => this._setActive(tabId));
    ipcMain.handle('tab:list', () => this._list());
  }

  _open(tabId, url) {
    if (this.tabs.has(tabId)) {
      // Idempotent — a remount from React shouldn't tear down state.
      if (url) this._navigate(tabId, url);
      return;
    }
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Phase 2 — every view gets the same preload, which stamps
        // window.__tabId from this argv value. Phase 3's Playwright MCP
        // (and any current Playwright client) uses page.evaluate(() =>
        // window.__tabId) to correlate CDP Page objects back to our tabIds.
        preload: path.join(__dirname, 'preload-tab.js'),
        additionalArguments: [`--ai-ide-tab-id=${tabId}`],
      },
    });
    // Hidden until the renderer makes it the active tab — avoids a flash
    // of unstyled content in the top-left corner before layout settles.
    // Bounds default to the editor-body rect from the most recent
    // setBounds (or 0×0 on cold start), so MCP screenshots on inactive
    // tabs work without having to be made active first.
    view.setVisible(false);
    view.setBounds(this.defaultBounds ?? { x: 0, y: 0, width: 0, height: 0 });

    const wc = view.webContents;
    this._wireEvents(tabId, view);

    // Window-open policy: payment/OAuth hosts → standalone BrowserWindow;
    // everything else → the renderer's open-tab IPC so it becomes a workspace
    // tab. Mirrors the previous main-window popup policy.
    wc.setWindowOpenHandler(({ url: openUrl }) => {
      if (!openUrl || /^(about|chrome|devtools):/.test(openUrl)) {
        return { action: 'deny' };
      }
      if (isPaymentUrl(openUrl)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560, height: 780,
            webPreferences: { nodeIntegration: false, contextIsolation: true },
          },
        };
      }
      // Forward to renderer; main window catches it and creates a tab.
      const owner = this.getOwnerWindow();
      if (owner && !owner.isDestroyed()) {
        const label = (() => { try { return new URL(openUrl).hostname || openUrl; } catch { return openUrl; } })();
        owner.webContents.send('open-tab', { url: openUrl, label });
      }
      return { action: 'deny' };
    });

    const owner = this.getOwnerWindow();
    if (owner && !owner.isDestroyed()) {
      owner.contentView.addChildView(view);
    } else {
      this.dbg('tab:open with no owner window — view stays detached for now');
    }

    this.tabs.set(tabId, { view, visible: false, lastBounds: null });
    if (url) wc.loadURL(url).catch((err) => this.dbg(`loadURL failed tabId=${tabId} err=${err.message}`));
  }

  _destroy(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    const owner = this.getOwnerWindow();
    try {
      if (owner && !owner.isDestroyed()) {
        owner.contentView.removeChildView(entry.view);
      }
    } catch (err) {
      this.dbg('removeChildView failed: ' + err.message);
    }
    try { entry.view.webContents.close(); } catch (err) { this.dbg('close failed: ' + err.message); }
    this.tabs.delete(tabId);
  }

  _navigate(tabId, url) {
    const entry = this.tabs.get(tabId);
    if (!entry || !url) return;
    if (entry.view.webContents.getURL() === url) return;
    entry.view.webContents.loadURL(url).catch((err) => this.dbg(`navigate failed tabId=${tabId} err=${err.message}`));
  }

  _reload(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    entry.view.webContents.reload();
  }

  _setVisible(tabId, visible) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    entry.visible = !!visible;
    entry.view.setVisible(!!visible);
    if (visible && entry.lastBounds) {
      // Re-apply last known bounds — Electron occasionally drops them on
      // hide/show transitions, leaving the view a 0×0 invisible target.
      entry.view.setBounds(entry.lastBounds);
    }
  }

  _setBounds(tabId, rect) {
    if (!rect) return;
    const norm = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    // Apply to the named tab AND every other tab. All tabs live in the
    // same editor-body area; only visibility differs. Mirroring bounds is
    // what lets Playwright MCP screenshots succeed against tabs that the
    // user has never had active — without it, those views sit at 0×0 and
    // captureScreenshot fails with "Cannot take screenshot with 0 width".
    for (const [otherId, other] of this.tabs) {
      other.lastBounds = norm;
      other.view.setBounds(norm);
      void otherId;
    }
    // Cache for new tabs created later (so they don't open at 0×0 either).
    this.defaultBounds = norm;
    void tabId;
  }

  _setActive(tabId) {
    // Accept null/undefined to mean "no active tab" (e.g. while a modal is
    // up and the workspace shell is greyed out). The renderer is the sole
    // source of truth — main doesn't second-guess.
    this.activeTabId = tabId ?? null;
  }

  _list() {
    const tabs = [];
    for (const [tabId, entry] of this.tabs) {
      tabs.push({
        tabId,
        url: entry.view.webContents.getURL(),
        visible: !!entry.visible,
        bounds: entry.lastBounds,
      });
    }
    return { tabs, activeTabId: this.activeTabId };
  }

  async _capture(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry) throw new Error(`capture: no tab ${tabId}`);
    const image = await entry.view.webContents.capturePage();
    const png = image.toPNG();
    const size = image.getSize();
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: size.width,
      height: size.height,
    };
  }

  _wireEvents(tabId, view) {
    const wc = view.webContents;
    const send = (channel, payload) => {
      const owner = this.getOwnerWindow();
      if (owner && !owner.isDestroyed()) owner.webContents.send(channel, payload);
    };

    wc.on('did-start-loading', () => send('tab:loading-change', { tabId, loading: true }));
    wc.on('did-stop-loading', () => send('tab:loading-change', { tabId, loading: false }));
    wc.on('page-title-updated', (_e, title) => send('tab:title-change', { tabId, title }));
    wc.on('did-navigate', (_e, url) => send('tab:url-change', { tabId, url }));
    wc.on('did-navigate-in-page', (_e, url) => send('tab:url-change', { tabId, url }));
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        this.dbg(`did-fail-load tabId=${tabId} code=${errorCode} url=${validatedURL} desc=${errorDescription}`);
      }
    });
  }
}

module.exports = { TabManager };
