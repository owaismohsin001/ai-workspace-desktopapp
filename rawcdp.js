'use strict';
// Minimal raw-CDP driver for a single page target, bypassing Playwright
// (Playwright's connectOverCDP asserts on the odoo bus_shared_worker
// target and refuses to connect). Uses Node 24's global WebSocket.
//
// Usage:
//   node rawcdp.js find <urlSubstr>            -> prints target ws url
//   node rawcdp.js shot <urlSubstr> <outPng>   -> screenshot the page
//   node rawcdp.js type <urlSubstr> <text>     -> insert text into focused el
//   node rawcdp.js key  <urlSubstr> <KeyName>  -> press a key (Enter, etc.)
//   node rawcdp.js click <urlSubstr> <x> <y>   -> mouse click at x,y
//   node rawcdp.js activate <urlSubstr>        -> bring tab to front

const http = require('http');
const fs = require('fs');

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
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', e => reject(new Error('ws error')));
  });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
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

async function keyEvent(c, keyName) {
  const map = {
    Enter:  { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  };
  const k = map[keyName];
  if (!k) throw new Error('unknown key ' + keyName);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

(async () => {
  const [, , cmd, sub, a, b] = process.argv;
  const t = await findTarget(sub);

  if (cmd === 'find') { console.log(t.webSocketDebuggerUrl); return; }
  if (cmd === 'activate') { await httpGet('/json/activate/' + t.id); console.log('ACTIVATED'); return; }

  const c = cdp(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  if (cmd === 'shot') {
    await httpGet('/json/activate/' + t.id);
    await new Promise(r => setTimeout(r, 400));
    const res = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(a, Buffer.from(res.data, 'base64'));
    console.log('saved', a);
  } else if (cmd === 'type') {
    await c.send('Input.insertText', { text: a });
    console.log('typed');
  } else if (cmd === 'key') {
    await keyEvent(c, a);
    console.log('key', a);
  } else if (cmd === 'eval') {
    const res = await c.send('Runtime.evaluate', {
      expression: a,
      returnByValue: true,
    });
    console.log(JSON.stringify(res.result?.value ?? res.result));
  } else if (cmd === 'click') {
    const x = Number(a), y = Number(b);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log('clicked', x, y);
  } else {
    console.log('unknown cmd', cmd);
  }
  c.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

// Hard safety timeout — never hang the parent shell.
setTimeout(() => { console.error('ERR timeout'); process.exit(2); }, 25000);
