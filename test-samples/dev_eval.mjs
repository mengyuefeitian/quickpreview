// 连接 WebView2 CDP，执行指定 JS 文件里的表达式并打印结果
// 用法：node dev_eval.mjs <js文件> [等待毫秒]
import { readFileSync } from 'node:fs';

const port = Number(process.env.CDP_PORT || 9222);
const exprFile = process.argv[2];
const settle = Number(process.argv[3] || 800);
const expr = readFileSync(exprFile, 'utf8').replace(/__PAGE__/g, process.env.PAGE || '');

async function pickTarget() {
  for (let i = 0; i < 80; i++) {
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
if (!target) { console.log('TARGET_NOT_FOUND'); process.exit(1); }

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
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
  });
}

await send('Runtime.enable');
await new Promise((r) => setTimeout(r, settle));

const r = await send('Runtime.evaluate', {
  expression: `(async () => { ${expr} })()`,
  awaitPromise: true, returnByValue: true
});
if (r.exceptionDetails) {
  console.log('EXCEPTION', JSON.stringify(r.exceptionDetails).slice(0, 2000));
} else {
  console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1));
}

const shot = process.env.SHOT;
if (shot) {
  const { writeFileSync } = await import('node:fs');
  const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(shot, Buffer.from(cap.data, 'base64'));
  console.log('SHOT ' + shot);
}
ws.close();
process.exit(0);
