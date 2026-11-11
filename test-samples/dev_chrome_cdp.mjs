// 用本机 Chrome（headless）跑渲染断言，不需要 WebView2 / GPU。
//
// 为什么不用 WebView2：本机 WebView2 解码子进程必崩，而且起一次要 5~6 秒；
// docx 版面/编号/页码这类「只跟 CSS 与 DOM 有关」的问题，用 Chrome headless
// 复现又快又稳 —— 它是同一个内核，`getComputedStyle(::before).content`、
// 真实分页高度、CSS 计数器全都准确。
//
// 用法：
//   node test-samples/dev_chrome_cdp.mjs --url file:///x/probe.html \
//        --wait "window.__READY" --shot out.png --eval "expr1" --eval "expr2"
//
// 参数：
//   --url   <url>      必填
//   --wait  <expr>     轮询到表达式为真（最多 60s），省略则等 load 后 500ms
//   --eval  <expr>     执行并打印结果（可多次；结果按顺序输出 JSON）
//   --shot  <png>      截图（整页）
//   --size  WxH        视口尺寸，默认 1000x1400
//   --port  N          调试端口，默认 9333
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = { url: '', wait: '', evals: [], shot: '', size: '1000x1400', port: 9333 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url') opt.url = argv[++i];
  else if (a === '--wait') opt.wait = argv[++i];
  else if (a === '--eval') opt.evals.push(argv[++i]);
  else if (a === '--shot') opt.shot = argv[++i];
  else if (a === '--size') opt.size = argv[++i];
  else if (a === '--port') opt.port = Number(argv[++i]);
}
if (!opt.url) { console.error('缺少 --url'); process.exit(2); }

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('未找到 Chrome/Edge'); process.exit(2); }

const [W, H] = opt.size.split('x').map(Number);
const profile = path.join(os.tmpdir(), `qpchrome_${Date.now()}`);
const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  `--remote-debugging-port=${opt.port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${opt.port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 端口没起来 */ }
    await sleep(150);
  }
  return null;
}

const target = await findTarget();
if (!target) { console.error('CDP_TARGET_NOT_FOUND'); child.kill(); process.exit(1); }

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
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: opt.url });
await sleep(600);

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r.result?.value;
}

if (opt.wait) {
  let ok = false;
  for (let i = 0; i < 300; i++) {
    if (await evalJs(`(()=>{try{return !!(${opt.wait})}catch(e){return false}})()`)) { ok = true; break; }
    await sleep(200);
  }
  if (!ok) {
    console.log('WAIT_TIMEOUT' + (await evalJs('document.title')));
    child.kill();
    process.exit(1);
  }
} else {
  await sleep(500);
}

for (const expr of opt.evals) {
  const v = await evalJs(expr);
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
}

if (opt.shot) {
  const scale = await evalJs('document.documentElement.scrollHeight');
  const h = Math.max(H, Math.min(8000, Number(scale) || H));
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: W, height: h, scale: 1 },
  });
  writeFileSync(opt.shot, Buffer.from(shot.data, 'base64'));
  console.log('SHOT ' + opt.shot + ' ' + W + 'x' + h);
}

ws.close();
child.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(0);
