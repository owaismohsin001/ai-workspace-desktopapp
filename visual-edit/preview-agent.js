'use strict';

// ── In-page preview agent (visual-edit) ──────────────────────────────────
//
// Self-contained function injected into each pinned page (via
// Page.addScriptToEvaluateOnNewDocument + an immediate Runtime.evaluate). It
// owns everything that must live in page context:
//
//   ELEMENT PINS (precise CSS/text edits)
//   • bind(n?)            — adopt the host-resolved element: capture
//                           fingerprint + computed styles, tag it, draw badge.
//   • applyCss(n,p,v)     — live CSS preview via an adoptedStyleSheets rule
//                           keyed to [data-ve-pin] (specificity-safe, survives
//                           sibling re-renders).
//   • applyText(n,t)      — best-effort live text preview.
//
//   FREEFORM ANNOTATIONS (folded in from the old snapshot tools)
//   • setMode('off'|'comment'|'rect'|'pen') — arm an in-page draw surface.
//   • comment = click a point; rect = drag a box; pen = freehand stroke.
//     Each becomes a numbered shape annotation in page coordinates.
//
// Numbering is UNIFIED: pins and shapes draw from one in-page counter, so the
// number on the target screenshot is an unambiguous join key (no pin-1 and
// shape-1 collision). The host reads assigned numbers back from bind()/events.
//
// The overlay has two layers: a PIN layer (selection boxes + badges, hidden
// for the target screenshot) and a SHAPE layer (comment/rect/pen — kept
// visible so the agent sees the annotations in the captured pixels).
//
// Page→host events go through the CDP Runtime binding `__ve_emit__`.

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
  // SVG / icon paint — icons set colour via fill/stroke, not `color`.
  'fill', 'stroke',
];

function AGENT_BODY(CAPTURED_PROPS) {
  if (window.__VE__) return; // idempotent — survives re-injection

  var OVERLAY_ID = '__ve_overlay__';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var Z = 2147483646;
  var ACCENT_PIN = '#2563eb', ACCENT_SHAPE = '#ef4444', ACCENT_COMMENT = '#7c3aed';

  var counter = 0;
  function nextN() { return ++counter; }

  var pins = new Map();    // n -> { el, badge, box, detached, n, path }
  var shapes = new Map();  // n -> { n, kind, geom, note }
  var sheet = null;
  var rules = new Map();   // n -> { prop: value }
  var mode = 'off';
  var surface = null;
  var draft = null;        // shape being drawn

  var pinLayer = null, shapeLayer = null, shapeSvg = null;

  function emit(obj) {
    try { if (window.__ve_emit__) window.__ve_emit__(JSON.stringify(obj)); } catch (e) {}
  }
  function sx() { return window.scrollX || window.pageXOffset || 0; }
  function sy() { return window.scrollY || window.pageYOffset || 0; }

  /* ── live CSS preview ──────────────────────────────────────────────── */
  function ensureSheet() {
    if (sheet) return sheet;
    try {
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [].concat(document.adoptedStyleSheets || [], [sheet]);
    } catch (e) {
      var st = document.createElement('style');
      st.id = '__ve_style__';
      document.documentElement.appendChild(st);
      sheet = { _el: st, replaceSync: function (css) { st.textContent = css; } };
    }
    return sheet;
  }
  function cssName(prop) { return prop.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }); }
  function selectorFor(n) { return '[data-ve-pin="' + n + '"]'; }
  function rebuildSheet() {
    var css = '';
    rules.forEach(function (decls, n) {
      var body = '';
      Object.keys(decls).forEach(function (prop) { body += '  ' + cssName(prop) + ': ' + decls[prop] + ' !important;\n'; });
      if (body) css += selectorFor(n) + ' {\n' + body + '}\n';
    });
    var s = ensureSheet();
    try { s.replaceSync(css); } catch (e) { if (s._el) s._el.textContent = css; }
  }

  /* ── overlay (two layers) ──────────────────────────────────────────── */
  function ensureOverlay() {
    var ov = document.getElementById(OVERLAY_ID);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:' + Z + ';';
    pinLayer = document.createElement('div');
    pinLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
    shapeLayer = document.createElement('div');
    shapeLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
    shapeSvg = document.createElementNS(SVGNS, 'svg');
    shapeSvg.setAttribute('width', '100%');
    shapeSvg.setAttribute('height', '100%');
    shapeSvg.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;overflow:visible;';
    shapeLayer.appendChild(shapeSvg);
    ov.appendChild(shapeLayer);
    ov.appendChild(pinLayer);
    (document.body || document.documentElement).appendChild(ov);
    return ov;
  }

  function makeBadge(n) {
    ensureOverlay();
    var box = document.createElement('div');
    box.style.cssText =
      'position:fixed;border:2px solid ' + ACCENT_PIN + ';border-radius:4px;' +
      'box-shadow:0 0 0 1px rgba(37,99,235,.25);pointer-events:none;transition:opacity .1s;';
    var badge = document.createElement('div');
    badge.textContent = String(n);
    badge.setAttribute('data-n', String(n));
    badge.style.cssText =
      'position:fixed;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:' + ACCENT_PIN + ';' +
      'color:#fff;font:600 11px/18px ui-sans-serif,system-ui,sans-serif;text-align:center;' +
      'pointer-events:auto;cursor:pointer;user-select:none;box-shadow:0 1px 3px rgba(0,0,0,.35);';
    badge.addEventListener('click', function (e) {
      e.stopPropagation();
      emit({ type: 'select', n: Number(badge.getAttribute('data-n')) });
    });
    pinLayer.appendChild(box);
    pinLayer.appendChild(badge);
    return { badge: badge, box: box };
  }

  function safeQuery(sel) { if (!sel) return null; try { return document.querySelector(sel); } catch (e) { return null; } }

  function position(n) {
    var p = pins.get(n);
    if (!p) return;
    var el = p.el;
    if (!el || !el.isConnected) {
      var found = safeQuery(p.path);
      if (found) {
        p.el = el = found;
        try { found.setAttribute('data-ve-pin', String(p.n)); } catch (e) {}
        if (p.detached) { p.detached = false; emit({ type: 'detachstate', n: p.n, detached: false }); }
      } else {
        p.box.style.opacity = '0'; p.badge.style.opacity = '.4';
        if (!p.detached) { p.detached = true; emit({ type: 'detachstate', n: p.n, detached: true }); }
        return;
      }
    }
    if (p.detached) { p.detached = false; p.box.style.opacity = '1'; p.badge.style.opacity = '1'; emit({ type: 'detachstate', n: p.n, detached: false }); }
    var r = el.getBoundingClientRect();
    p.box.style.left = r.left + 'px'; p.box.style.top = r.top + 'px';
    p.box.style.width = Math.max(0, r.width - 4) + 'px'; p.box.style.height = Math.max(0, r.height - 4) + 'px';
    p.badge.style.left = Math.max(2, r.left) + 'px'; p.badge.style.top = Math.max(2, r.top - 9) + 'px';
  }

  /* ── shape rendering ───────────────────────────────────────────────── */
  function mk(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function svgText(s, x, y) {
    var t = mk('text', { x: x, y: y, fill: '#fff', 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.textContent = s; return t;
  }
  function svgLabel(n, x, y, color) {
    var cx = Math.max(11, x), cy = Math.max(11, y);
    shapeSvg.appendChild(mk('circle', { cx: cx, cy: cy, r: 9, fill: color, stroke: '#fff', 'stroke-width': 1.5 }));
    shapeSvg.appendChild(svgText(String(n), cx, cy));
  }
  function drawShape(s, isDraft) {
    var ox = sx(), oy = sy();
    if (s.kind === 'rect') {
      shapeSvg.appendChild(mk('rect', { x: s.geom.x - ox, y: s.geom.y - oy, width: s.geom.w, height: s.geom.h, fill: 'rgba(239,68,68,0.06)', stroke: ACCENT_SHAPE, 'stroke-width': 2, rx: 2, opacity: 0.95 }));
      if (!isDraft) svgLabel(s.n, s.geom.x - ox + 9, s.geom.y - oy - 9, ACCENT_SHAPE);
    } else if (s.kind === 'pen') {
      var pts = s.geom.points.map(function (p) { return (p.x - ox) + ',' + (p.y - oy); }).join(' ');
      shapeSvg.appendChild(mk('polyline', { points: pts, fill: 'none', stroke: ACCENT_SHAPE, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.95 }));
      if (!isDraft && s.geom.points.length) svgLabel(s.n, s.geom.points[0].x - ox, s.geom.points[0].y - oy - 12, ACCENT_SHAPE);
    } else if (s.kind === 'comment') {
      var cx = s.geom.x - ox, cy = s.geom.y - oy;
      shapeSvg.appendChild(mk('circle', { cx: cx, cy: cy, r: 11, fill: ACCENT_COMMENT, stroke: '#fff', 'stroke-width': 2 }));
      shapeSvg.appendChild(svgText(String(s.n), cx, cy));
    }
  }
  function renderShapes() {
    if (!shapeSvg) return;
    while (shapeSvg.firstChild) shapeSvg.removeChild(shapeSvg.firstChild);
    shapes.forEach(function (s) { drawShape(s, false); });
    if (draft) drawShape(draft, true);
  }

  /* ── tracking ──────────────────────────────────────────────────────── */
  var raf = 0, lastTick = 0;
  function tick() { raf = 0; lastTick = Date.now(); pins.forEach(function (_p, n) { position(n); }); renderShapes(); }
  function schedule() {
    if (raf) return;
    var since = Date.now() - lastTick;
    if (since >= 80) { tick(); }
    else { raf = requestAnimationFrame(function () { setTimeout(tick, 80 - since); }); }
  }
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule, true);
  window.addEventListener('load', schedule);

  /* ── capture / fingerprint ─────────────────────────────────────────── */
  function capture(el) { var cs = getComputedStyle(el); var out = {}; CAPTURED_PROPS.forEach(function (p) { out[p] = cs[p]; }); return out; }
  function cssPath(el) {
    var parts = [], node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var sel = node.tagName.toLowerCase();
      if (node.id) { sel += '#' + CSS.escape(node.id); parts.unshift(sel); break; }
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (cls.length) sel += '.' + cls.slice(0, 2).map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) sel += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel); node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function fingerprint(el) {
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    var loc = el.getAttribute('data-loc') || (el.dataset && (el.dataset.loc || el.dataset.sourceLoc)) || null;
    return { tag: el.tagName.toLowerCase(), text: text, path: cssPath(el), loc: loc };
  }

  /* ── draw surface ──────────────────────────────────────────────────── */
  function pageXY(e) { return { x: e.clientX + sx(), y: e.clientY + sy() }; }
  function wireSurface(sf) {
    var drawing = false, start = null;
    sf.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (mode === 'comment') {
        var pt = pageXY(e); var n = nextN(); var s = { n: n, kind: 'comment', geom: { x: pt.x, y: pt.y }, note: '' };
        shapes.set(n, s); renderShapes(); emit({ type: 'shape', shape: s });
        return;
      }
      drawing = true; start = pageXY(e);
      draft = mode === 'rect'
        ? { n: 0, kind: 'rect', geom: { x: start.x, y: start.y, w: 0, h: 0 } }
        : { n: 0, kind: 'pen', geom: { points: [start] } };
      try { sf.setPointerCapture(e.pointerId); } catch (er) {}
      renderShapes();
    });
    sf.addEventListener('pointermove', function (e) {
      if (!drawing) return; var pt = pageXY(e);
      if (mode === 'rect') draft.geom = { x: Math.min(start.x, pt.x), y: Math.min(start.y, pt.y), w: Math.abs(pt.x - start.x), h: Math.abs(pt.y - start.y) };
      else if (mode === 'pen') draft.geom.points.push(pt);
      renderShapes();
    });
    function finish() {
      if (!drawing) return; drawing = false;
      var d = draft; draft = null;
      if (!d) { renderShapes(); return; }
      if (d.kind === 'rect' && (d.geom.w < 5 || d.geom.h < 5)) { renderShapes(); return; }
      if (d.kind === 'pen' && d.geom.points.length < 2) { renderShapes(); return; }
      var n = nextN(); d.n = n; d.note = ''; shapes.set(n, d); renderShapes();
      emit({ type: 'shape', shape: d });
    }
    sf.addEventListener('pointerup', finish);
    sf.addEventListener('pointercancel', finish);
  }

  /* ── public API ────────────────────────────────────────────────────── */
  window.__VE__ = {
    version: 2,

    bind: function (explicitN) {
      var el = this && this.nodeType === 1 ? this : arguments[1];
      if (!el) return null;
      var n = (typeof explicitN === 'number') ? explicitN : nextN();
      if (typeof explicitN === 'number' && explicitN > counter) counter = explicitN;
      el.setAttribute('data-ve-pin', String(n));
      var existing = pins.get(n);
      if (existing) { existing.box.remove(); existing.badge.remove(); }
      var vis = makeBadge(n);
      var fp = fingerprint(el);
      pins.set(n, { el: el, badge: vis.badge, box: vis.box, detached: false, n: n, path: fp.path });
      position(n);
      var hasDirectText = Array.prototype.some.call(el.childNodes, function (nd) {
        return nd.nodeType === 3 && nd.textContent.replace(/\s/g, '').length > 0;
      });
      return { n: n, fingerprint: fp, computed: capture(el), text: (el.textContent || '').slice(0, 2000), textEditable: hasDirectText };
    },

    applyCss: function (n, prop, value) {
      var decls = rules.get(n) || {}; decls[prop] = value; rules.set(n, decls); rebuildSheet(); position(n);
    },
    applyText: function (n, text) {
      var p = pins.get(n);
      if (p && p.el && p.el.isConnected) { try { p.el.textContent = text; } catch (e) {} position(n); }
    },

    // Arm/disarm the in-page draw surface. 'off' removes it (so element
    // picking + normal page interaction resume).
    setMode: function (m) {
      mode = m || 'off';
      if (mode === 'off') { if (surface) { surface.remove(); surface = null; } return; }
      ensureOverlay();
      if (!surface) {
        surface = document.createElement('div');
        surface.style.cssText = 'position:fixed;inset:0;z-index:' + (Z + 1) + ';pointer-events:auto;';
        document.getElementById(OVERLAY_ID).appendChild(surface);
        wireSurface(surface);
      }
      surface.style.cursor = mode === 'comment' ? 'cell' : 'crosshair';
    },

    setNote: function (n, note) { var s = shapes.get(n); if (s) s.note = note || ''; },

    removePin: function (n) {
      var p = pins.get(n);
      if (p) { if (p.el && p.el.removeAttribute) p.el.removeAttribute('data-ve-pin'); p.box.remove(); p.badge.remove(); }
      pins.delete(n); rules.delete(n); rebuildSheet();
      if (shapes.has(n)) { shapes.delete(n); renderShapes(); }
    },

    restore: function (list) {
      (list || []).forEach(function (item) {
        var el = safeQuery(item.path);
        if (el) { window.__VE__.bind.call(el, item.n); return; }
        var existing = pins.get(item.n);
        if (existing) { existing.box.remove(); existing.badge.remove(); }
        var vis = makeBadge(item.n);
        vis.box.style.opacity = '0'; vis.badge.style.opacity = '.4';
        pins.set(item.n, { el: null, badge: vis.badge, box: vis.box, detached: true, n: item.n, path: item.path });
        if (item.n > counter) counter = item.n;
      });
      schedule();
      return Array.from(pins.keys());
    },
    restoreShapes: function (list) {
      (list || []).forEach(function (s) { shapes.set(s.n, s); if (s.n > counter) counter = s.n; });
      renderShapes();
    },

    clearAll: function () {
      pins.forEach(function (p) { if (p.el && p.el.removeAttribute) p.el.removeAttribute('data-ve-pin'); });
      pins.clear(); shapes.clear(); rules.clear(); mode = 'off';
      if (surface) { surface.remove(); surface = null; }
      var ov = document.getElementById(OVERLAY_ID);
      if (ov) ov.remove();
      pinLayer = shapeLayer = shapeSvg = null;
      if (sheet) { try { sheet.replaceSync(''); } catch (e) {} }
    },

    // Hide only the PIN layer (selection boxes + badges) for the target
    // screenshot — shapes stay visible because they ARE the annotation the
    // agent must see in the pixels.
    setOverlayVisible: function (v) { if (pinLayer) pinLayer.style.display = v ? '' : 'none'; },
  };
}

const AGENT_SOURCE = '(' + AGENT_BODY.toString() + ')(' + JSON.stringify(CAPTURED_PROPS) + ');';

module.exports = { AGENT_SOURCE, CAPTURED_PROPS };
