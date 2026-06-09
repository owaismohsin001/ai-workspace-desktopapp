'use strict';

// ── Visual-edit platform tool — main-process entry ───────────────────────
//
// Registers the `visual-edit:*` IPC surface and owns the live sessions. One
// session per tab (keyed by tabId). The renderer (frontend VisualEditorPanel)
// drives it through __AIIDE__.visualEdit (see preload.js); events flow back
// over the channels listed in EVENTS.
//
// Lifecycle mirrors the tool interface in visual-edit-tool-plan.md:
//   startSession → listPins → applyEdit / setNote / removePin → buildEditTask
//   → (renderer hands payload to the chat agent) → endSession
//
// `applyEdits` / `verify` are NOT main-process ops: the source edit + the
// Playwright pixel-diff run inside the user's workspace via the chat agent's
// existing Playwright MCP access (AIIDE_MCP_PORT). buildPayload produces
// exactly what that agent consumes; see verify.js for the diff recipe.

const { ipcMain } = require('electron');
const { Session } = require('./session');

class VisualEdit {
  /**
   * @param {object} opts
   * @param {() => Electron.BrowserWindow|null} opts.getOwnerWindow
   * @param {(tabId:string) => Electron.WebContents|null} opts.getWebContents
   * @param {(...a:any[]) => void} [opts.dbg]
   */
  constructor({ getOwnerWindow, getWebContents, dbg }) {
    this.getOwnerWindow = getOwnerWindow;
    this.getWebContents = getWebContents;
    this.dbg = dbg ?? (() => {});
    /** @type {Map<string, Session>} sessionId -> Session */
    this.sessions = new Map();
    /** @type {Map<string, string>} tabId -> sessionId */
    this.byTab = new Map();
    this._seq = 0;
    this._register();
  }

  _emit(channel, payload) {
    const win = this.getOwnerWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  _session(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('visual-edit: unknown session ' + sessionId);
    return s;
  }

  _register() {
    const h = (name, fn) => ipcMain.handle(name, async (_e, args) => {
      try { return await fn(args ?? {}); }
      catch (err) {
        this.dbg(`visual-edit ${name} error: ` + (err?.stack ?? err));
        return { error: String(err?.message ?? err) };
      }
    });

    h('visual-edit:start', async ({ tabId }) => {
      if (this.byTab.has(tabId)) {
        const existing = this.sessions.get(this.byTab.get(tabId));
        if (existing) { await existing.resumePicking(); return { sessionId: existing.id, pins: existing.listPins() }; }
      }
      const wc = this.getWebContents(tabId);
      if (!wc) throw new Error('no live view for tab ' + tabId);
      const sessionId = `ve-${++this._seq}-${tabId}`;
      const session = new Session(sessionId, tabId, wc, (c, p) => this._emit(c, p), this.dbg);
      this.sessions.set(sessionId, session);
      this.byTab.set(tabId, sessionId);
      await session.start();
      return { sessionId, pins: [] };
    });

    h('visual-edit:listPins', ({ sessionId }) => ({ pins: this._session(sessionId).listPins() }));
    h('visual-edit:applyEdit', ({ sessionId, n, change }) => this._session(sessionId).applyEdit(n, change));
    h('visual-edit:setNote', ({ sessionId, n, note }) => this._session(sessionId).setNote(n, note));
    h('visual-edit:removePin', ({ sessionId, n }) => this._session(sessionId).removePin(n));
    h('visual-edit:pausePicking', ({ sessionId }) => this._session(sessionId).pausePicking());
    h('visual-edit:resumePicking', ({ sessionId }) => this._session(sessionId).resumePicking());
    h('visual-edit:buildEditTask', ({ sessionId }) => this._session(sessionId).buildPayload());

    h('visual-edit:end', async ({ sessionId }) => {
      const s = this.sessions.get(sessionId);
      if (s) {
        await s.end();
        this.sessions.delete(sessionId);
        this.byTab.delete(s.tabId);
      }
      return { ok: true };
    });
  }

  /** Tear down all sessions (window-all-closed / sign-out). */
  async destroyAll() {
    for (const s of this.sessions.values()) await s.end().catch(() => {});
    this.sessions.clear();
    this.byTab.clear();
  }
}

module.exports = { VisualEdit };
