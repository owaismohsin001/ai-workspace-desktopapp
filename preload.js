'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Subscribers registered by the workspace frontend to receive open-tab events.
const openTabListeners = [];

contextBridge.exposeInMainWorld('__AIIDE__', {
  isElectron: true,
  electronVersion: process.versions.electron,

  // workspace-shell.tsx calls this to receive popup→tab redirects.
  // Returns an unsubscribe function (call it in useEffect cleanup).
  onOpenTab: (callback) => {
    openTabListeners.push(callback);
    return () => {
      const i = openTabListeners.indexOf(callback);
      if (i !== -1) openTabListeners.splice(i, 1);
    };
  },
});

// Main process sends 'open-tab' when a popup should become a workspace tab.
ipcRenderer.on('open-tab', (event, { url, label }) => {
  for (const cb of openTabListeners) {
    try { cb(url, label || url); } catch {}
  }
});
