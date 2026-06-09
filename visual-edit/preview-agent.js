'use strict';

// ── In-page preview agent (visual-edit) ──────────────────────────────────
//
// This module exports the SOURCE of a self-contained function that runs
// *inside* each pinned page (injected by picker.js via
// Page.addScriptToEvaluateOnNewDocument + an immediate Runtime.evaluate for
// the already-loaded document). It owns everything that must live in page
// context:
//
//   • window.__VE__.bind(el, n)       — adopt a picked element as pin N:
//                                        capture its fingerprint + computed
//                                        styles, tag it, draw its badge.
//   • window.__VE__.applyCss(n,p,v)    — live CSS preview via a constructable
//                                        adoptedStyleSheets rule keyed to the
//                                        pin's selector (specificity-safe,
//                                        survives SPA re-renders of siblings).
//   • window.__VE__.applyText(n,t)     — best-effort live text preview.
//   • window.__VE__.removePin(n) / clearAll()
//
// Picking itself is host-side (Overlay.setInspectMode, browser-rendered) —
// see the plan's "decisions locked". The agent is injected ANYWAY for live
// editing, so the numbered-pin overlay rides along in the page instead of a
// separate host-side WebContentsView: once injected JS is accepted for
// editing, reusing it for the overlay is simpler and keeps badges glued to
// elements for free (in-page getBoundingClientRect, no CDP round-trips).
//
// Page→host events (pin selected from a badge click, pin detached on
// re-render) are pushed through the CDP Runtime binding `__ve_emit__`, which
// picker.js registers and listens for via Runtime.bindingCalled.

// The curated computed-style subset the inspector seeds from. Real CSS
// property names → the inspector decomposes split fields (box-shadow, grid)
// on its side. Keep in sync with the frontend VisualEditorPanel seed map.
const CAPTURED_PROPS = [
  'width', 'height',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'display', 'flexDirection', 'justifyContent', 'alignItems', 'flexWrap', 'gap',
  'gridTemplateColumns', 'gridTemplateRows',
  'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'color',
  'backgroundColor',
  'borderTopWidth', 'borderStyle', 'borderColor', 'borderRadius',
  'boxShadow', 'opacity',
];

// The agent body. Stringified and injected — it must NOT close over anything
// from this module (CAPTURED_PROPS is interpolated in below).
function AGENT_BODY(CAPTURED_PROPS) {
  if (window.__VE__) return; // idempotent — survives re-injection

  var OVERLAY_ID = '__ve_overlay__';
  var Z = 2147483646;
  var pins = new Map(); // n -> { el, badge, box }
  var sheet = null;
  var rules = new Map(); // n -> { prop: value }

  function emit(obj) {
    try { if (window.__ve_emit__) window.__ve_emit__(JSON.stringify(obj)); } catch (e) {}
  }

  function ensureSheet() {
    if (sheet) return sheet;
    try {
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [].concat(document.adoptedStyleSheets || [], [sheet]);
    } catch (e) {
      // Fallback for engines without constructable stylesheets.
      var st = document.createElement('style');
      st.id = '__ve_style__';
      document.documentElement.appendChild(st);
      sheet = { _el: st, cssRules: [], replaceSync: function (css) { st.textContent = css; } };
    }
    return sheet;
  }

  function selectorFor(n) { return '[data-ve-pin="' + n + '"]'; }

  function rebuildSheet() {
    var css = '';
    rules.forEach(function (decls, n) {
      var body = '';
      Object.keys(decls).forEach(function (prop) {
        body += '  ' + cssName(prop) + ': ' + decls[prop] + ' !important;\n';
      });
      if (body) css += selectorFor(n) + ' {\n' + body + '}\n';
    });
    var s = ensureSheet();
    try { s.replaceSync(css); } catch (e) { if (s._el) s._el.textContent = css; }
  }

  function cssName(prop) {
    return prop.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); });
  }

  // ── overlay ────────────────────────────────────────────────────────────
  function ensureOverlay() {
    var ov = document.getElementById(OVERLAY_ID);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:' + Z + ';';
    (document.body || document.documentElement).appendChild(ov);
    return ov;
  }

  function makeBadge(n) {
    var box = document.createElement('div');
    box.style.cssText =
      'position:fixed;border:2px solid #2563eb;border-radius:4px;' +
      'box-shadow:0 0 0 1px rgba(37,99,235,.25);pointer-events:none;' +
      'transition:opacity .1s;';
    var badge = document.createElement('div');
    badge.textContent = String(n);
    badge.setAttribute('data-n', String(n));
    badge.style.cssText =
      'position:fixed;min-width:18px;height:18px;padding:0 4px;border-radius:9px;' +
      'background:#2563eb;color:#fff;font:600 11px/18px ui-sans-serif,system-ui,sans-serif;' +
      'text-align:center;pointer-events:auto;cursor:pointer;user-select:none;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.35);';
    // Read the number at click time (not closure capture) so it stays correct
    // across renumber(), which mutates data-n in place.
    badge.addEventListener('click', function (e) {
      e.stopPropagation();
      emit({ type: 'select', n: Number(badge.getAttribute('data-n')) });
    });
    var ov = ensureOverlay();
    ov.appendChild(box);
    ov.appendChild(badge);
    return { badge: badge, box: box };
  }

  function position(n) {
    var p = pins.get(n);
    if (!p) return;
    var el = p.el;
    if (!el || !el.isConnected) {
      // Node was replaced (SPA re-render). Flag detached; hide visuals.
      p.box.style.opacity = '0';
      p.badge.style.opacity = '.4';
      if (!p.detached) { p.detached = true; emit({ type: 'detached', n: n }); }
      return;
    }
    if (p.detached) { p.detached = false; p.box.style.opacity = '1'; p.badge.style.opacity = '1'; }
    var r = el.getBoundingClientRect();
    p.box.style.left = r.left + 'px';
    p.box.style.top = r.top + 'px';
    p.box.style.width = Math.max(0, r.width - 4) + 'px';
    p.box.style.height = Math.max(0, r.height - 4) + 'px';
    p.badge.style.left = Math.max(2, r.left) + 'px';
    p.badge.style.top = Math.max(2, r.top - 9) + 'px';
  }

  // Throttled tracking (~12fps) — N pins on scroll/resize. Coalesced.
  var raf = 0, lastTick = 0;
  function tick() {
    raf = 0;
    lastTick = Date.now();
    pins.forEach(function (_p, n) { position(n); });
  }
  function schedule() {
    if (raf) return;
    var since = Date.now() - lastTick;
    if (since >= 80) { tick(); }
    else { raf = requestAnimationFrame(function () { setTimeout(tick, 80 - since); }); }
  }
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule, true);

  // ── computed-style capture ──────────────────────────────────────────────
  function capture(el) {
    var cs = getComputedStyle(el);
    var out = {};
    CAPTURED_PROPS.forEach(function (prop) { out[prop] = cs[prop]; });
    return out;
  }

  // Short, reasonably-unique CSS path for re-localization by the agent.
  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var sel = node.tagName.toLowerCase();
      if (node.id) { sel += '#' + CSS.escape(node.id); parts.unshift(sel); break; }
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (cls.length) sel += '.' + cls.slice(0, 2).map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sameTag.length > 1) sel += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function fingerprint(el) {
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    var loc = el.getAttribute('data-loc')
      || (el.dataset && (el.dataset.loc || el.dataset.sourceLoc))
      || null;
    return { tag: el.tagName.toLowerCase(), text: text, path: cssPath(el), loc: loc };
  }

  // ── public API ───────────────────────────────────────────────────────────
  window.__VE__ = {
    version: 1,

    // Adopt the host-resolved element as pin N. `this` is the element when
    // invoked via Runtime.callFunctionOn; el arg also accepted for direct use.
    bind: function (n) {
      var el = this && this.nodeType === 1 ? this : arguments[1];
      if (!el) return null;
      el.setAttribute('data-ve-pin', String(n));
      var existing = pins.get(n);
      if (existing) { existing.box.remove(); existing.badge.remove(); }
      var vis = makeBadge(n);
      pins.set(n, { el: el, badge: vis.badge, box: vis.box, detached: false });
      position(n);
      return { fingerprint: fingerprint(el), computed: capture(el) };
    },

    applyCss: function (n, prop, value) {
      var decls = rules.get(n) || {};
      decls[prop] = value;
      rules.set(n, decls);
      rebuildSheet();
      position(n);
    },

    applyText: function (n, text) {
      var p = pins.get(n);
      if (p && p.el && p.el.isConnected) {
        try { p.el.textContent = text; } catch (e) {}
        position(n);
      }
    },

    removePin: function (n) {
      var p = pins.get(n);
      if (p) {
        if (p.el && p.el.removeAttribute) p.el.removeAttribute('data-ve-pin');
        p.box.remove(); p.badge.remove();
      }
      pins.delete(n);
      rules.delete(n);
      rebuildSheet();
    },

    // Renumber: oldN -> newN (after a pin is removed and the list compacts).
    renumber: function (map) {
      var snapshotPins = new Map(pins), snapshotRules = new Map(rules);
      pins.clear(); rules.clear();
      Object.keys(map).forEach(function (oldN) {
        var newN = map[oldN];
        var p = snapshotPins.get(Number(oldN));
        if (p) {
          if (p.el && p.el.setAttribute) p.el.setAttribute('data-ve-pin', String(newN));
          p.badge.textContent = String(newN);
          p.badge.setAttribute('data-n', String(newN));
          p.n = Number(newN);
          pins.set(Number(newN), p);
        }
        var r = snapshotRules.get(Number(oldN));
        if (r) snapshotRules.set(Number(newN), r), rules.set(Number(newN), r);
      });
      rebuildSheet();
      schedule();
    },

    clearAll: function () {
      pins.forEach(function (p) {
        if (p.el && p.el.removeAttribute) p.el.removeAttribute('data-ve-pin');
      });
      pins.clear(); rules.clear();
      var ov = document.getElementById(OVERLAY_ID);
      if (ov) ov.remove();
      if (sheet) { try { sheet.replaceSync(''); } catch (e) {} }
    },

    // Show/hide overlay (e.g. hide before capturing the target screenshot so
    // badges don't bake into the pixels the agent must match — the payload
    // builder can re-show them in a separate reference shot).
    setOverlayVisible: function (v) {
      var ov = document.getElementById(OVERLAY_ID);
      if (ov) ov.style.display = v ? '' : 'none';
    },
  };
}

// Serialize the agent for injection. CAPTURED_PROPS is baked in as a literal.
const AGENT_SOURCE =
  '(' + AGENT_BODY.toString() + ')(' + JSON.stringify(CAPTURED_PROPS) + ');';

module.exports = { AGENT_SOURCE, CAPTURED_PROPS };
