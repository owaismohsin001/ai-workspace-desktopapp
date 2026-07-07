'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Exposes a minimal, safe IPC surface to the connect.html renderer.
// No Node.js APIs leak through — contextIsolation ensures that.
contextBridge.exposeInMainWorld('__AIIDE_CONNECT__', {
  /** Open the platform's /desktop/auth page in the system browser. */
  openPlatformBrowser: (platformUrl) =>
    ipcRenderer.invoke('open-platform-browser', platformUrl),

  /** Connect directly using a manually entered workspace URL. */
  connectManual: (workspaceUrl) =>
    ipcRenderer.invoke('connect-manual', workspaceUrl),

  /** Enterprise sign-in: workspace URL + username + password. */
  connectEnterprise: (payload) =>
    ipcRenderer.invoke('connect-enterprise', payload),

  /** Fetch initial config (platformUrl) from the main process. */
  getConfig: () => ipcRenderer.invoke('get-config'),
});
