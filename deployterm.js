'use strict';
// Robust deploy driver for the code-server terminal over raw CDP.
//
// The reliability problem after an app relaunch is FOCUS, not dead PTYs
// (code-server keeps PTYs server-side across browser reloads). So this:
//   1. Ensures the terminal panel is VISIBLE (Ctrl+` if no visible screen).
//   2. Clicks the VISIBLE .xterm-screen to focus its live terminal.
//   3. Focuses the matching helper textarea, types the command, presses Enter.
//
//   node deployterm.js <urlSub> <b64cmd>
const http = require('http');
function get(p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222' + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
  });
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pend = new Map();
  const ready = new Promise((rs, rj) => { ws.addEventListener('open', () => rs()); ws.addEventListener('error', () => rj(new Error('ws error'))); });
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
  const send = (method, params = {}) => { const myId = ++id; return new Promise((resolve, reject) => { pend.set(myId, { resolve, reject }); ws.send(JSON.stringify({ id: myId, method, params })); }); };
  return { ready, send, close: () => ws.close() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ev(c, expr) { const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.value; }
// Returns center {x,y} of the visible terminal screen, or null.
async function visibleRect(c) {
  // Pick the ON-SCREEN terminal with the largest visible area. Inactive
  // terminals stay in the DOM but are positioned off-screen (negative top),
  // so we must reject anything outside the viewport, not just check
  // offsetParent.
  const j = await ev(c, `(()=>{const H=innerHeight,W=innerWidth;let best=null,area=0;for(const s of document.querySelectorAll('.xterm-screen')){const r=s.getBoundingClientRect();if(r.width<20||r.height<20)continue;if(r.top<0||r.left<0||r.top>H-20||r.left>W-20)continue;const a=r.width*r.height;if(a>area){area=a;best={x:r.x+r.width/2,y:r.y+r.height/2};}}return best?JSON.stringify(best):null;})()`);
  return j ? JSON.parse(j) : null;
}
(async () => {
  const [, , sub, b64] = process.argv;
  const text = Buffer.from(b64, 'base64').toString('utf8');
  const list = JSON.parse(await get('/json/list'));
  const t = list.find(x => x.type === 'page' && (x.url || '').includes(sub));
  if (!t) throw new Error('target not found: ' + sub);
  await get('/json/activate/' + t.id);
  const c = cdp(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  // The code-server tab may be a 0x0 WebContentsView (not the active desktop
  // tab), so coordinate clicks are useless. But Input.insertText / key events
  // go to the FOCUSED element regardless of geometry. So just ensure a
  // terminal textarea is focused (JS .focus(), geometry-independent) and type.
  const active = await ev(c, `document.activeElement && document.activeElement.className || ''`);
  if (!/xterm-helper-textarea/.test(active || '')) {
    const focused = await ev(c, `(()=>{const a=document.querySelectorAll('.xterm-helper-textarea');if(!a.length)return 'NONE';a[a.length-1].focus();return 'focused n='+a.length;})()`);
    if (focused === 'NONE') { console.log('ERR no terminal textarea'); c.close(); process.exit(3); }
    await sleep(250);
  }
  await c.send('Input.insertText', { text });
  await sleep(150);
  for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 });
  console.log('active=' + active + ' -> SENT');
  c.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
setTimeout(() => { console.log('ERR timeout'); process.exit(2); }, 20000);
