'use strict';

// Injected into every <webview> via will-attach-webview → webPreferences.preload.
//
// Problem: window.open() inside a <webview> (without the allowpopups HTML attr)
// is blocked by Chromium before any Electron handler fires. The call returns null
// and sites like Stripe checkout show "browser blocked popup".
//
// Why the simple patch failed: with contextIsolation:true the preload runs in its
// own V8 context. Patching window.open there doesn't touch the PAGE's window.open
// — they are different objects.
//
// Fix: expose an IPC function to the page via contextBridge, then inject a
// <script> element into the page's DOM. DOM-injected scripts always run in the
// PAGE's JS context regardless of isolation, so they can replace window.open.

const { contextBridge, ipcRenderer } = require('electron');

// Step 1 — expose the IPC call to the page's global scope.
contextBridge.exposeInMainWorld('__electronPopup', (url) => {
  ipcRenderer.invoke('webview-popup-open', { url });
});

// Step 2 — inject a script into the page context that replaces window.open.
// We append to documentElement immediately (preload runs synchronously before
// any page HTML is parsed) so the patch is in place before page scripts execute.
const script = document.createElement('script');
script.textContent = `
(function () {
  var _orig = window.open;
  window.open = function patchedOpen(url, target, features) {
    if (!url || /^(about:|javascript:|blob:)/.test(String(url))) {
      return typeof _orig === 'function' ? _orig.apply(this, arguments) : null;
    }
    // Route to main process — opens a real BrowserWindow.
    if (typeof window.__electronPopup === 'function') {
      window.__electronPopup(String(url));
    }
    // Return a truthy mock so callers don't hit their "blocked" fallback branch.
    var href = String(url);
    return {
      closed: false,
      name: target || '',
      opener: null,
      close:       function () {},
      focus:       function () {},
      blur:        function () {},
      postMessage: function () {},
      location: {
        href: href,
        assign:   function (u) { href = String(u); },
        replace:  function (u) { href = String(u); },
        toString: function ()  { return href; }
      }
    };
  };
})();
`;
document.documentElement.appendChild(script);
