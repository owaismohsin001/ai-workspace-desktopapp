'use strict';

// ── Host-side CDP picker + agent bridge (visual-edit) ────────────────────
//
// Drives a single tab's WebContentsView over Electron's in-process
// `webContents.debugger` (no WS socket — sidesteps the connectOverCDP
// bus_shared_worker assertion that rawcdp.js was written to dodge, and keeps
// us off the shared 9222 endpoint the Playwright MCP server uses).
//
// Picking is browser-rendered via Overlay.setInspectMode (survives a frozen
// or looping page) and is ONE-SHOT — we re-arm after every pick for
// multi-select, per the plan's locked decision. On each pick we resolve the
// backendNodeId to a live JS handle and hand it into the in-page agent's
// __VE__.bind(n), which captures the fingerprint + computed styles and draws
// the numbered badge.
//
// Guards: attach() throws if DevTools is open on the same view (a debugger
// session and DevTools can't co-exist) — callers surface that to the user.

const { AGENT_SOURCE } = require('./preview-agent');

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: false,
  contentColor: { r: 37, g: 99, b: 235, a: 0.28 },
  paddingColor: { r: 16, g: 185, b: 129, a: 0.28 },
  marginColor: { r: 245, g: 158, b: 11, a: 0.28 },
  borderColor: { r: 37, g: 99, b: 235, a: 0.6 },
};

class Picker {
  /**
   * @param {Electron.WebContents} wc      The tab view's webContents.
   * @param {object} hooks
   * @param {() => number} hooks.nextPinNumber  Returns the number to assign
   *     the next pick (session owns the counter).
   * @param {(pin:{n:number,backendNodeId:number,fingerprint:object,computed:object}) => void} hooks.onPick
   * @param {(n:number) => void} [hooks.onSelect]    Badge clicked in-page.
   * @param {(n:number) => void} [hooks.onDetached]  Pin's node was replaced.
   * @param {(...a:any[]) => void} [hooks.dbg]
   */
  constructor(wc, hooks) {
    this.wc = wc;
    this.hooks = hooks;
    this.dbg = hooks.dbg ?? (() => {});
    this.armed = false;
    this.attached = false;
    this._onMessage = this._onMessage.bind(this);
  }

  get dbgr() { return this.wc.debugger; }

  async attach() {
    if (this.attached) return;
    if (this.wc.isDestroyed()) throw new Error('visual-edit: webContents destroyed');
    if (this.wc.isDevToolsOpened()) {
      throw new Error('Close DevTools on this tab before starting a visual edit session.');
    }
    try {
      this.dbgr.attach('1.3');
    } catch (err) {
      throw new Error('visual-edit: debugger attach failed — ' + err.message);
    }
    this.attached = true;
    this.dbgr.on('message', this._onMessage);
    this.dbgr.on('detach', () => { this.attached = false; this.armed = false; });

    await this.send('DOM.enable');
    await this.send('CSS.enable').catch(() => {}); // optional
    await this.send('Overlay.enable');
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    // page→host channel used by the agent for badge-select / detach events.
    await this.send('Runtime.addBinding', { name: '__ve_emit__' });
    // Inject for future navigations AND the current document.
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: AGENT_SOURCE });
    await this.send('Runtime.evaluate', { expression: AGENT_SOURCE });
    this.dbg('visual-edit picker attached');
  }

  send(method, params = {}) {
    return this.dbgr.sendCommand(method, params);
  }

  async _onMessage(_event, method, params) {
    try {
      if (method === 'Overlay.inspectNodeRequested') {
        await this._handlePick(params.backendNodeId);
      } else if (method === 'Runtime.bindingCalled' && params.name === '__ve_emit__') {
        let msg;
        try { msg = JSON.parse(params.payload); } catch { return; }
        if (msg.type === 'select') this.hooks.onSelect?.(msg.n);
        else if (msg.type === 'detachstate') this.hooks.onDetached?.(msg.n, msg.detached);
      } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
        // Top-level navigation re-runs addScriptToEvaluateOnNewDocument; pins
        // are gone. Session listens for url-change and resets its list.
      }
    } catch (err) {
      this.dbg('visual-edit picker message error: ' + err.message);
    }
  }

  async _handlePick(backendNodeId) {
    const n = this.hooks.nextPinNumber();
    let resolved;
    try {
      resolved = await this.send('DOM.resolveNode', { backendNodeId });
    } catch (err) {
      this.dbg('resolveNode failed: ' + err.message);
      await this.arm(); // keep picking
      return;
    }
    const objectId = resolved.object?.objectId;
    if (!objectId) { await this.arm(); return; }

    let bound = null;
    try {
      const res = await this.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(n){ return window.__VE__ ? window.__VE__.bind.call(this, n) : null; }',
        arguments: [{ value: n }],
        returnByValue: true,
      });
      bound = res.result?.value ?? null;
    } catch (err) {
      this.dbg('bind callFunctionOn failed: ' + err.message);
    } finally {
      try { await this.send('Runtime.releaseObject', { objectId }); } catch {}
    }

    if (bound) {
      this.hooks.onPick({
        n,
        backendNodeId,
        fingerprint: bound.fingerprint,
        computed: bound.computed,
        text: bound.text,
        textEditable: bound.textEditable,
      });
    }
    // One-shot inspect mode — re-arm for the next pick.
    await this.arm();
  }

  async arm() {
    if (!this.attached) return;
    this.armed = true;
    await this.send('Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: HIGHLIGHT_CONFIG,
    });
  }

  async disarm() {
    if (!this.attached) return;
    this.armed = false;
    await this.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT_CONFIG })
      .catch(() => {});
  }

  /** Call a method on the in-page __VE__ agent with JSON-serializable args. */
  async callAgent(methodName, args = []) {
    const expr = `window.__VE__ && window.__VE__.${methodName}.apply(window.__VE__, ${JSON.stringify(args)})`;
    const res = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return res.result?.value ?? null;
  }

  /** Re-inject the agent (after a navigation cleared it). */
  async reinject() {
    await this.send('Runtime.evaluate', { expression: AGENT_SOURCE }).catch(() => {});
  }

  async captureScreenshot() {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return res.data; // base64
  }

  async detach() {
    if (!this.attached) return;
    try { await this.disarm(); } catch {}
    try { await this.callAgent('clearAll'); } catch {}
    try { this.dbgr.detach(); } catch {}
    this.attached = false;
    this.armed = false;
  }
}

module.exports = { Picker };
