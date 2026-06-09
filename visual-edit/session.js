'use strict';

// ── Visual-edit session ──────────────────────────────────────────────────
//
// One session per active tab. Owns the pin list + per-pin annotation deltas,
// orchestrates the Picker (host-side CDP), and builds the agent payload.
//
// The number is the join key (plan): pin N binds one node + fingerprint +
// recorded { from → to } delta. The live-edited page is the spec; the agent
// reproduces the deltas in source and pixel-diffs against the captured target
// screenshot.

const { Picker } = require('./picker');

/**
 * @typedef {Object} Annotation
 * @property {Record<string,{from:string,to:string}>} css   real CSS props
 * @property {{from:string,to:string}=} text
 * @property {string=} note
 */

class Session {
  /**
   * @param {string} sessionId
   * @param {string} tabId
   * @param {Electron.WebContents} wc
   * @param {(channel:string, payload:any) => void} emitToRenderer  push events
   * @param {(...a:any[]) => void} dbg
   */
  constructor(sessionId, tabId, wc, emitToRenderer, dbg) {
    this.id = sessionId;
    this.tabId = tabId;
    this.wc = wc;
    this.emit = emitToRenderer;
    this.dbg = dbg ?? (() => {});
    this._counter = 0;
    /** @type {Map<number, {n:number, backendNodeId:number, fingerprint:object, computed:object, annotation:Annotation, detached:boolean}>} */
    this.pins = new Map();

    this.picker = new Picker(wc, {
      nextPinNumber: () => ++this._counter,
      onPick: (p) => this._onPick(p),
      onSelect: (n) => this.emit('visual-edit:pin-selected', { sessionId: this.id, n }),
      onDetached: (n) => {
        const pin = this.pins.get(n);
        if (pin) pin.detached = true;
        this.emit('visual-edit:pin-detached', { sessionId: this.id, n });
      },
      dbg: this.dbg,
    });

    // Re-inject the agent after a same-tab navigation wiped it. Pins from the
    // old document are stale; clear them so the renderer drops their badges.
    this._onNav = () => {
      this.picker.reinject().then(() => this.picker.arm()).catch(() => {});
      if (this.pins.size) {
        this.pins.clear();
        this.emit('visual-edit:reset', { sessionId: this.id });
      }
    };
    wc.on('did-navigate', this._onNav);
  }

  async start() {
    await this.picker.attach();
    await this.picker.arm();
  }

  /** Pause picking (e.g. while the user is editing in the inspector). */
  async pausePicking() { await this.picker.disarm(); }
  async resumePicking() { await this.picker.arm(); }

  _onPick(p) {
    this.pins.set(p.n, {
      n: p.n,
      backendNodeId: p.backendNodeId,
      fingerprint: p.fingerprint,
      computed: p.computed,
      annotation: { css: {} },
      detached: false,
    });
    this.emit('visual-edit:pin-added', {
      sessionId: this.id,
      pin: this._publicPin(p.n),
    });
  }

  _publicPin(n) {
    const pin = this.pins.get(n);
    if (!pin) return null;
    return {
      n: pin.n,
      fingerprint: pin.fingerprint,
      computed: pin.computed,
      annotation: pin.annotation,
      detached: pin.detached,
    };
  }

  listPins() {
    return Array.from(this.pins.keys()).sort((a, b) => a - b).map((n) => this._publicPin(n));
  }

  /**
   * Record + live-apply one edit. `change` is already composed to real CSS by
   * the inspector (compose-to-CSS lives there). Shapes:
   *   { kind:'css', prop, value, from }
   *   { kind:'text', value, from }
   */
  async applyEdit(n, change) {
    const pin = this.pins.get(n);
    if (!pin) return { error: 'no such pin ' + n };

    if (change.kind === 'css') {
      const { prop, value, from } = change;
      const existing = pin.annotation.css[prop];
      pin.annotation.css[prop] = { from: existing ? existing.from : (from ?? ''), to: value };
      // Drop a delta that was reverted back to its original value.
      if (pin.annotation.css[prop].from === value) delete pin.annotation.css[prop];
      await this.picker.callAgent('applyCss', [n, prop, value]);
    } else if (change.kind === 'text') {
      const { value, from } = change;
      const origFrom = pin.annotation.text ? pin.annotation.text.from : (from ?? '');
      if (origFrom === value) delete pin.annotation.text;
      else pin.annotation.text = { from: origFrom, to: value };
      await this.picker.callAgent('applyText', [n, value]);
    }
    return { ok: true, annotation: pin.annotation };
  }

  setNote(n, note) {
    const pin = this.pins.get(n);
    if (!pin) return { error: 'no such pin ' + n };
    if (note) pin.annotation.note = note;
    else delete pin.annotation.note;
    return { ok: true };
  }

  async removePin(n) {
    if (!this.pins.has(n)) return { ok: true };
    await this.picker.callAgent('removePin', [n]);
    this.pins.delete(n);
    await this._renumber();
    return { ok: true, pins: this.listPins() };
  }

  // Compact pin numbers to 1..N (stable order) after a removal.
  async _renumber() {
    const ordered = Array.from(this.pins.keys()).sort((a, b) => a - b);
    const map = {};
    let next = 1;
    const rebuilt = new Map();
    for (const oldN of ordered) {
      const pin = this.pins.get(oldN);
      pin.n = next;
      rebuilt.set(next, pin);
      map[oldN] = next;
      next += 1;
    }
    this.pins = rebuilt;
    this._counter = next - 1;
    await this.picker.callAgent('renumber', [map]);
    this.emit('visual-edit:renumbered', { sessionId: this.id, pins: this.listPins() });
  }

  /**
   * Build the agent task: the target screenshot (live-edited page, badges
   * hidden so they don't bake into the pixels the agent must match) + the
   * annotation set keyed by pin number + fingerprint.
   */
  async buildPayload() {
    await this.picker.disarm();
    await this.picker.callAgent('setOverlayVisible', [false]);
    let dataB64 = null;
    try {
      dataB64 = await this.picker.captureScreenshot();
    } finally {
      await this.picker.callAgent('setOverlayVisible', [true]);
    }
    const annotations = this.listPins().filter((p) => {
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
    this.pins.clear();
  }
}

module.exports = { Session };
