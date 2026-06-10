'use strict';

// ── Visual-edit verification oracle (Phase 8) ────────────────────────────
//
// The live-edited page IS the spec: buildEditTask captured a target
// screenshot of exactly what the user produced visually. After the chat
// agent edits source and HMR re-renders, it screenshots the result and
// pixel-diffs it against that target. A near-zero diff is an EXACT oracle for
// everything the user touched — no human approval gate needed.
//
// This does NOT run in the Electron main process. It runs inside the user's
// workspace, invoked by the chat agent through its Playwright MCP access
// (AIIDE_MCP_PORT) — the same surface the agent already uses to drive the
// preview. Kept here so the recipe ships with the tool and stays versioned
// alongside the payload format it consumes.
//
// Capture discipline (must match how the target was captured to avoid false
// diffs): lock the viewport + deviceScaleFactor, disable animations, and
// `await document.fonts.ready` before BOTH captures. The target screenshot
// was taken via CDP Page.captureScreenshot at the tab's own device scale, so
// the verifier must render the result tab at the same bounds.
//
// Usage (Node, inside the workspace; pixelmatch + pngjs are tiny deps the
// agent installs if missing):
//
//   const { diffPng } = require('./verify');
//   const { mismatch, ratio, diffPath } = diffPng(targetPng, resultPng, 'diff.png');
//   if (ratio > 0.004) { /* feed diff.png + failing pin back for one pass */ }

/**
 * Pixel-diff two PNG buffers. Returns the mismatched-pixel count, the ratio
 * over total pixels, and writes a highlighted diff image when outPath is set.
 *
 * @param {Buffer} targetPng   the captured live-edited target (the spec)
 * @param {Buffer} resultPng   screenshot of the post-edit source render
 * @param {string} [outPath]   where to write the visual diff (optional)
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.1]  per-pixel color-distance threshold
 * @returns {{ mismatch:number, ratio:number, width:number, height:number, diffPath:(string|null) }}
 */
function diffPng(targetPng, resultPng, outPath, opts = {}) {
  // Lazy require so this file can be read/shipped without the deps present.
  const { PNG } = require('pngjs');
  const pixelmatch = require('pixelmatch');
  const fs = require('fs');

  const a = PNG.sync.read(targetPng);
  const b = PNG.sync.read(resultPng);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `visual-edit verify: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}. ` +
      `Lock viewport + deviceScaleFactor on the result capture to match the target.`
    );
  }
  const { width, height } = a;
  const diff = new PNG({ width, height });
  const mismatch = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: opts.threshold ?? 0.1,
    includeAA: false,
  });
  let diffPath = null;
  if (outPath) { fs.writeFileSync(outPath, PNG.sync.write(diff)); diffPath = outPath; }
  return { mismatch, ratio: mismatch / (width * height), width, height, diffPath };
}

// A small accept threshold: ~0.4% of pixels. Sub-pixel AA + cursor/caret
// jitter produce a non-zero floor even on a correct edit; this rides above it
// while still catching a wrong color / spacing / missing change.
const DEFAULT_ACCEPT_RATIO = 0.004;

module.exports = { diffPng, DEFAULT_ACCEPT_RATIO };
