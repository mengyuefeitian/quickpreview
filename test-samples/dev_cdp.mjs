// 通过 WebView2 远程调试端口驱动预览页（不依赖鼠标模拟，锁屏也能跑）
//
// 用法：
//   node _cdp.mjs <输出png> "<要执行的JS>" [等待毫秒]
//
// 前提：宿主以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动。
import { writeFileSync } from 'node:fs';

const port = Number(process.env.CDP_PORT || 9222);
const outPng = process.argv[2] || '';
const expr = process.argv[3] || '';
const settle = Number(process.argv[4] || 800);

async function pickTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && String(t.url || '').includes('app.local'));
      if (p && p.webSocketDebuggerUrl) return p;
    } catch { /* 端口还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

const target = await pickTarget();
if (!target) {
  console.log('TARGET_NOT_FOUND');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error('timeout ' + method)); }
    }, 20000);
  });
}

await send('Runtime.enable');
await send('Page.enable');

// 特殊指令：把页面/窗口切到前台（等价于用户点击窗口，SetForegroundWindow 从后台进程调用会失败）
if (expr === '__BRING__') {
  await send('Page.bringToFront');
  console.log('BRING ok');
} else if (expr.startsWith('__WHEEL__')) {
  // 真实滚轮：必须走 Input.dispatchMouseEvent —— 页面里 dispatchEvent(new WheelEvent(…))
  // 是"不可信事件"，浏览器不会执行默认滚动动作，测不出"滚到底再翻页"的行为。
  // 形式：__WHEEL__:<次数>:<方向 1|-1>[:x:y]
  const [, n, dirRaw, xx, yy] = expr.split(':');
  const times = Number(n) || 5;
  const dir = Number(dirRaw) === -1 ? -1 : 1;
  const x = Number(xx) || 600;
  const y = Number(yy) || 400;
  const seq = [];
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY: 120 * dir,
      modifiers: 0, pointerType: 'mouse', button: 'none', clickCount: 0
    });
    await new Promise((r) => setTimeout(r, 180));
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('.preview-bar'); const v = document.querySelector('.docx-viewer') || document.querySelector('.pdf-viewer'); const m = (b ? b.innerText : '').match(/第 (\\d+)/); return (m ? m[1] : '?') + '@' + (v ? v.scrollTop : '-'); })()`,
      returnByValue: true
    });
    seq.push(r && r.result ? r.result.value : '?');
  }
  console.log('WHEEL ' + seq.join(' → '));
} else if (expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true
  });
  const val = r && r.result ? r.result.value : undefined;
  if (r && r.exceptionDetails) console.log('EVAL_ERROR', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  else console.log('EVAL', typeof val === 'string' ? val : JSON.stringify(val));
}

if (settle) await new Promise((r) => setTimeout(r, settle));

if (outPng) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('SHOT', outPng);
}

ws.close();
process.exit(0);
