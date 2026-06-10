'use strict';

// ── Visual-edit session ──────────────────────────────────────────────────
//
// One session per active tab. Owns a single numbered list of ANNOTATIONS —
// element pins (precise CSS/text edits) and freeform shapes (comment / rect /
// pen) — all sharing one counter (assigned in-page by the agent) so the
// number on the target screenshot is an unambiguous join key. Orchestrates the
// Picker (host-side CDP) and builds the agent payload.
//
// The live-edited page is the spec; the agent reproduces the deltas + honours
// the freeform annotations in source, then pixel-diffs against the captured
// target screenshot.

const { Picker } = require('./picker');

class Session {
  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {Electron.WebContents} wc
   * @param {(channel:string, payload:any) => void} emitToRenderer
   * @param {(...a:any[]) => void} dbg
   */
  constructor(sessionId, tabId, wc, emitToRenderer, dbg) {
    this.id = sessionId;
    this.tabId = tabId;
    this.wc = wc;
    this.emit = emitToRenderer;
    this.dbg = dbg ?? (() => {});
    /** @type {Map<number, object>} n -> item ('element' | 'comment' | 'rect' | 'pen') */
    this.items = new Map();
    this.mode = 'pick'; // 'pick' | 'comment' | 'rect' | 'pen' | 'off'

    this.picker = new Picker(wc, {
      onPick: (p) => this._onPick(p),
      onShape: (s) => this._onShape(s),
      onSelect: (n) => this.emit('visual-edit:pin-selected', { sessionId: this.id, n }),
      onDetached: (n, detached) => {
        const it = this.items.get(n);
        if (it) it.detached = !!detached;
        this.emit('visual-edit:pin-detached', { sessionId: this.id, n, detached: !!detached });
      },
      dbg: this.dbg,
    });

    this._homeUrl = null;
    this._onNav = (_e, url) => { void this._handleNav(url ?? this.wc.getURL()); };
    wc.on('did-navigate', this._onNav);
  }

  async start() {
    await this.picker.attach();
    this._homeUrl = this.wc.getURL();
    await this.picker.arm();
  }

  /* ── modes ───────────────────────────────────────────────────────────── */
  // 'pick' = host-side element inspect; comment/rect/pen = in-page draw
  // surface; 'off' = neither. They're mutually exclusive.
  async setMode(mode) {
    this.mode = mode;
    if (mode === 'pick') {
      await this.picker.callAgent('setMode', ['off']);
      await this.picker.arm();
    } else if (mode === 'off') {
      await this.picker.callAgent('setMode', ['off']);
      await this.picker.disarm();
    } else {
      await this.picker.disarm();
      await this.picker.callAgent('setMode', [mode]);
    }
    return { ok: true, mode };
  }
  async pausePicking() { return this.setMode('off'); }
  async resumePicking() { return this.setMode('pick'); }

  /* ── ingest ──────────────────────────────────────────────────────────── */
  _onPick(p) {
    this.items.set(p.n, {
      kind: 'element',
      n: p.n,
      backendNodeId: p.backendNodeId,
      fingerprint: p.fingerprint,
      computed: p.computed,
      text: p.text ?? '',
      textEditable: !!p.textEditable,
      annotation: { css: {} },
      detached: false,
    });
    this.emit('visual-edit:pin-added', { sessionId: this.id, pin: this._publicItem(p.n) });
  }

  _onShape(s) {
    this.items.set(s.n, { kind: s.kind, n: s.n, geom: s.geom, note: s.note || '' });
    this.emit('visual-edit:pin-added', { sessionId: this.id, pin: this._publicItem(s.n) });
  }

  _publicItem(n) {
    const it = this.items.get(n);
    if (!it) return null;
    if (it.kind === 'element') {
      return { n: it.n, kind: 'element', fingerprint: it.fingerprint, computed: it.computed, text: it.text, textEditable: it.textEditable, annotation: it.annotation, detached: it.detached };
    }
    return { n: it.n, kind: it.kind, geom: it.geom, note: it.note };
  }

  listPins() {
    return Array.from(this.items.keys()).sort((a, b) => a - b).map((n) => this._publicItem(n));
  }

  /* ── edits ───────────────────────────────────────────────────────────── */
  async applyEdit(n, change) {
    const it = this.items.get(n);
    if (!it || it.kind !== 'element') return { error: 'not an editable element pin: ' + n };
    if (change.kind === 'css') {
      const { prop, value, from } = change;
      const existing = it.annotation.css[prop];
      it.annotation.css[prop] = { from: existing ? existing.from : (from ?? ''), to: value };
      if (it.annotation.css[prop].from === value) delete it.annotation.css[prop];
      await this.picker.callAgent('applyCss', [n, prop, value]);
    } else if (change.kind === 'text') {
      const { value, from } = change;
      const origFrom = it.annotation.text ? it.annotation.text.from : (from ?? '');
      if (origFrom === value) delete it.annotation.text;
      else it.annotation.text = { from: origFrom, to: value };
      await this.picker.callAgent('applyText', [n, value]);
    }
    return { ok: true, annotation: it.annotation };
  }

  async setNote(n, note) {
    const it = this.items.get(n);
    if (!it) return { error: 'no such item ' + n };
    if (it.kind === 'element') {
      if (note) it.annotation.note = note; else delete it.annotation.note;
    } else {
      it.note = note || '';
      await this.picker.callAgent('setNote', [n, note || '']);
    }
    return { ok: true };
  }

  async removePin(n) {
    if (!this.items.has(n)) return { ok: true, pins: this.listPins() };
    await this.picker.callAgent('removePin', [n]);
    this.items.delete(n);
    // Numbers are STABLE (no renumber) — a gap is fine; the number is just a
    // join key and stable numbers keep the agent's references valid.
    this.emit('visual-edit:renumbered', { sessionId: this.id, pins: this.listPins() });
    return { ok: true, pins: this.listPins() };
  }

  /* ── reload survival ───────────────────────────────────────────────── */
  _samePage(a, b) {
    try {
      const ua = new URL(a), ub = new URL(b);
      return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
    } catch { return a === b; }
  }

  async _handleNav(url) {
    await this.picker.reinject().catch(() => {});
    if (this.items.size && this._homeUrl && this._samePage(url, this._homeUrl)) {
      const elements = [];
      const shapes = [];
      for (const it of this.items.values()) {
        if (it.kind === 'element') elements.push({ n: it.n, path: it.fingerprint.path });
        else shapes.push({ n: it.n, kind: it.kind, geom: it.geom, note: it.note });
      }
      if (elements.length) await this.picker.callAgent('restore', [elements]).catch(() => {});
      if (shapes.length) await this.picker.callAgent('restoreShapes', [shapes]).catch(() => {});
      for (const it of this.items.values()) {
        if (it.kind !== 'element') continue;
        for (const [prop, d] of Object.entries(it.annotation.css)) {
          await this.picker.callAgent('applyCss', [it.n, prop, d.to]).catch(() => {});
        }
        if (it.annotation.text) await this.picker.callAgent('applyText', [it.n, it.annotation.text.to]).catch(() => {});
      }
      this.emit('visual-edit:renumbered', { sessionId: this.id, pins: this.listPins() });
    } else if (this.items.size) {
      this.items.clear();
      this.emit('visual-edit:reset', { sessionId: this.id });
    }
    this._homeUrl = url;
    // Restore whatever mode was active before the nav.
    await this.setMode(this.mode).catch(() => {});
  }

  /* ── payload ───────────────────────────────────────────────────────── */
  async buildPayload() {
    // Hide the PIN layer (selection boxes/badges) for the target screenshot —
    // shapes stay visible because they ARE annotations the agent must see.
    await this.picker.callAgent('setMode', ['off']);
    await this.picker.disarm();
    await this.picker.callAgent('setOverlayVisible', [false]);
    let dataB64 = null;
    try {
      dataB64 = await this.picker.captureScreenshot();
    } finally {
      await this.picker.callAgent('setOverlayVisible', [true]);
    }
    const annotations = this.listPins().filter((p) => {
      if (p.kind !== 'element') return true; // every shape is an intentional annotation
      const a = p.annotation;
      return (a.css && Object.keys(a.css).length) || a.text || a.note;
    });
    return {
      sessionId: this.id,
      tabId: this.tabId,
      url: this.wc.getURL(),
      targetScreenshot: dataB64 ? `data:image/png;base64,${dataB64}` : null,
      annotations,
    };
  }

  async end() {
    try { this.wc.off('did-navigate', this._onNav); } catch {}
    await this.picker.detach().catch(() => {});
    this.items.clear();
  }
}

module.exports = { Session };
