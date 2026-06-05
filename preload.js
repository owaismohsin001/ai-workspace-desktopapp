'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Subscribers registered by the workspace frontend.
const openTabListeners = [];
const tabLoadingListeners = [];
const tabTitleListeners = [];
const tabUrlListeners = [];
const tunnelStatusListeners = [];

function subscribe(list, cb) {
  list.push(cb);
  return () => {
    const i = list.indexOf(cb);
    if (i !== -1) list.splice(i, 1);
  };
}

contextBridge.exposeInMainWorld('__AIIDE__', {
  isElectron: true,
  electronVersion: process.versions.electron,

  // ── Popup → tab routing ────────────────────────────────────────────
  // Main process sends 'open-tab' when a window.open() popup inside a tab
  // should be re-routed into a workspace tab (instead of staying a
  // standalone window). workspace-shell.tsx subscribes; returns an
  // unsubscribe function.
  onOpenTab: (cb) => subscribe(openTabListeners, cb),

  // ── Tab content lifecycle (Phase 1: <iframe> → WebContentsView) ─────
  // PreviewPane uses these to manage a main-process WebContentsView per
  // tab. When this surface is undefined (running in a plain browser
  // during `npm run dev`), PreviewPane falls back to rendering an
  // <iframe> the legacy way — so the frontend builds and runs without
  // Electron.
  tab: {
    open: (tabId, url) => ipcRenderer.invoke('tab:open', { tabId, url }),
    close: (tabId) => ipcRenderer.invoke('tab:close', { tabId }),
    navigate: (tabId, url) => ipcRenderer.invoke('tab:navigate', { tabId, url }),
    reload: (tabId) => ipcRenderer.invoke('tab:reload', { tabId }),
    setVisible: (tabId, visible) =>
      ipcRenderer.invoke('tab:setVisible', { tabId, visible }),
    setBounds: (tabId, rect) =>
      ipcRenderer.invoke('tab:setBounds', { tabId, rect }),
    /** Returns { dataUrl: 'data:image/png;base64,…', width, height }. */
    capture: (tabId) => ipcRenderer.invoke('tab:capture', { tabId }),
    /** Phase 5 — renderer reports the UI's active tabId to main on every
     *  switch. Pass null to clear (e.g. when no tab is selected). Main
     *  exposes the current value via list(). */
    setActive: (tabId) => ipcRenderer.invoke('tab:setActive', { tabId }),
    /** Phase 5 — { tabs: Array<{ tabId, url, visible, bounds }>, activeTabId }.
     *  Lets MCP-side scripts default tool actions to "current UI tab" by
     *  reading activeTabId, without scraping the renderer DOM. */
    list: () => ipcRenderer.invoke('tab:list'),

    // Event subscribers. Each returns an unsubscribe function.
    onLoadingChange: (cb) => subscribe(tabLoadingListeners, cb),
    onTitleChange: (cb) => subscribe(tabTitleListeners, cb),
    onUrlChange: (cb) => subscribe(tabUrlListeners, cb),
  },

  // Phase 6 — automated reverse SSH tunnel status.
  tunnel: {
    /** Subscribe to status updates. Callback receives
     *  `{ status, error, connectedAt }` where status is one of:
     *  'idle' | 'granting' | 'connecting' | 'connected' | 'reconnecting' | 'error'.
     *  Returns an unsubscribe function.
     *
     *  The callback also fires once immediately with the CURRENT status
     *  (fetched from main via IPC) — important because the React tree
     *  often mounts after the tunnel has already reached `connected`,
     *  so the first push event would otherwise be missed and the dot
     *  would stay grey forever. */
    onStatus: (cb) => {
      ipcRenderer.invoke('tunnel:getStatus').then((current) => {
        if (current) { try { cb(current); } catch {} }
      }).catch(() => { /* main not ready yet */ });
      return subscribe(tunnelStatusListeners, cb);
    },
  },
});

ipcRenderer.on('open-tab', (_event, { url, label }) => {
  for (const cb of openTabListeners) { try { cb(url, label || url); } catch {} }
});
ipcRenderer.on('tab:loading-change', (_event, { tabId, loading }) => {
  for (const cb of tabLoadingListeners) { try { cb(tabId, loading); } catch {} }
});
ipcRenderer.on('tab:title-change', (_event, { tabId, title }) => {
  for (const cb of tabTitleListeners) { try { cb(tabId, title); } catch {} }
});
ipcRenderer.on('tab:url-change', (_event, { tabId, url }) => {
  for (const cb of tabUrlListeners) { try { cb(tabId, url); } catch {} }
});
ipcRenderer.on('tunnel:status', (_event, payload) => {
  for (const cb of tunnelStatusListeners) { try { cb(payload); } catch {} }
});
