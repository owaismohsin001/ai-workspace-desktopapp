'use strict';
// One-shot CDP driver to deploy the backend via the code-server terminal.
// Built on the same raw-WebSocket plumbing as rawcdp.js (Playwright's
// connectOverCDP chokes on Odoo's bus_shared_worker target).
//
// Subcommands:
//   probe   <sub>            -> report terminal/xterm/renderer state
//   openterm <sub>           -> send trusted Ctrl+` to toggle a terminal
//   read    <sub>            -> dump current xterm viewport text
//   run     <sub> <b64cmd>   -> focus terminal, type cmd (base64), press Enter
const http = require('http');

function httpGet(path) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222' + path, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    }).on('error', rej);
  });
}
async function findTarget(sub) {
  const list = JSON.parse(await httpGet('/json/list'));
  const t = list.find(t => t.type === 'page' && (t.url || '').includes(sub));
  if (!t) throw new Error('target not found for: ' + sub);
  return t;
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    }
  });
  function send(method, params = {}) {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  return { ready, send, close: () => ws.close() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evalExpr(c, expr) {
  const res = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return res.result?.value;
}
async function combo(c, { key, code, vk, modifiers }) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}

(async () => {
  const [, , cmd, sub, arg] = process.argv;
  const t = await findTarget(sub);
  const c = cdp(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await httpGet('/json/activate/' + t.id);

  const readBuf = `(${(() => {
    const rows = document.querySelector('.xterm-rows');
    if (rows) return rows.innerText;
    const cv = document.querySelector('.xterm');
    return cv ? '[CANVAS_RENDERER count=' + document.querySelectorAll('.xterm').length + ']' : '[NO_XTERM]';
  }).toString()})()`;

  if (cmd === 'probe') {
    const out = await evalExpr(c, `JSON.stringify({xterm:document.querySelectorAll('.xterm').length, rows:document.querySelectorAll('.xterm-rows').length, screen:document.querySelectorAll('.xterm-screen').length, canvas:document.querySelectorAll('.xterm canvas').length})`);
    console.log(out);
  } else if (cmd === 'openterm') {
    // Ctrl+` toggles the integrated terminal. CDP input = trusted event.
    await combo(c, { key: '`', code: 'Backquote', vk: 192, modifiers: 2 });
    await sleep(2000);
    const out = await evalExpr(c, `JSON.stringify({xterm:document.querySelectorAll('.xterm').length, screen:document.querySelectorAll('.xterm-screen').length, canvas:document.querySelectorAll('.xterm canvas').length})`);
    console.log('after Ctrl+`:', out);
  } else if (cmd === 'read') {
    console.log(await evalExpr(c, readBuf));
  } else if (cmd === 'run') {
    const text = Buffer.from(arg, 'base64').toString('utf8');
    // focus terminal: click its screen center
    const rect = await evalExpr(c, `(()=>{const s=document.querySelector('.xterm-screen')||document.querySelector('.xterm');if(!s)return null;const r=s.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`);
    if (rect) {
      const { x, y } = JSON.parse(rect);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(200);
    }
    await c.send('Input.insertText', { text });
    await sleep(150);
    await combo(c, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 0 });
    console.log('SENT');
  } else {
    console.log('unknown cmd', cmd);
  }
  c.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
setTimeout(() => { console.error('ERR timeout'); process.exit(2); }, 25000);
