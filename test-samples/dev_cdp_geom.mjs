// 连到已经跑起来的预览窗口（CDP 9222），量 Word 页面的布局几何并截图。
//
// 为什么单独写：dev_webview_shot.mjs 会自己拉起 exe，遇到单实例互斥体或端口
// 被占时就拿不到 target（CDP_TARGET_NOT_FOUND）。这个脚本只连不管进程，
// 适合「程序已经开着，我想立刻看一眼它当前算成什么样」。
//
// 用法：
//   node publish/QuickPreview.exe --preview <文档> --quiet   # 先启动（带调试端口）
//   node test-samples/dev_cdp_geom.mjs [--shot out.png] [--port 9222]
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let shot = '', port = 9222, keyTaps = 0, keyName = 'ArrowDown';
const keyCode = (k) => (k === 'ArrowUp' ? 38 : k === 'ArrowLeft' ? 37 : k === 'ArrowRight' ? 39 : 40);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--shot') shot = argv[++i];
  else if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--keys') keyTaps = Number(argv[++i]);
  else if (argv[i] === '--key') keyName = argv[++i];
}

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WebView2 起来后先是 about:blank，导航到 app.local 还要 1~2 秒，轮询等它
let list = [];
let target = null;
for (let i = 0; i < 40; i++) {
  try { list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`)); } catch { list = []; }
  target = list.find((t) => t.type === 'page' && String(t.url).includes('app.local'));
  if (target) break;
  await sleep(500);
}
if (!target) { console.error('没有 app.local 页面，列表：' + JSON.stringify(list.map((t) => t.url))); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  waiting.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

// 等页面渲染完（底部栏出现 Word）
for (let i = 0; i < 60; i++) {
  const bar = await ev(`(()=>{const b=document.querySelector('.preview-bar');return b?b.innerText:''})()`);
  if (typeof bar === 'string' && bar.includes('Word')) break;
  await sleep(500);
}

const DUMP = `(()=>{
  const v = document.querySelector('.docx-viewer');
  const w = document.querySelector('.docx-preview-wrapper');
  const c = w ? getComputedStyle(w) : null;
  const secs = [...document.querySelectorAll('.docx-viewer section')];
  const vis = secs.filter((s) => s.style.visibility !== 'hidden');
  const vr = v ? v.getBoundingClientRect() : { left: 0, right: 0, width: 0 };
  return JSON.stringify({
    viewerW: Math.round(vr.width),
    wrapper: c ? { dir: c.flexDirection, justify: c.justifyContent, align: c.alignItems, w: Math.round(w.getBoundingClientRect().width) } : null,
    stageZoom: (document.querySelector('.docx-stage') || {}).style ? document.querySelector('.docx-stage').style.zoom : '',
    pages: secs.length, visible: vis.length,
    geom: vis.map((s) => { const r = s.getBoundingClientRect(); return { left: Math.round(r.left - vr.left), right: Math.round(vr.right - r.right), w: Math.round(r.width) }; }),
    bar: (document.querySelector('.preview-bar') || {}).innerText
  });
})()`;

console.log('SINGLE ' + await ev(DUMP));

// --keys N：注入 N 次 ↓，每次打印底部栏里的当前文件名（验证翻页顺序用）。
// 宿主窗口虽在前台，但 WebView2 拿不到键盘焦点时按真键没反应，
// 用 Input.dispatchKeyEvent 直接喂给页面最可靠。
if (Number(keyTaps) > 0) {
  const nameNow = `(()=>{const b=document.querySelector('.preview-bar .pb-name');return b?b.textContent:'-'})()`;
  console.log('KEY 起点 ' + await ev(nameNow));
  for (let i = 0; i < Number(keyTaps); i++) {
    const base = { key: keyName, code: keyName, windowsVirtualKeyCode: keyCode(keyName), nativeVirtualKeyCode: keyCode(keyName) };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(700);
    console.log(`KEY #${i + 1} ` + await ev(nameNow));
  }
}
if (shot) {
  const s1 = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shot.replace(/\.png$/i, '-single.png'), Buffer.from(s1.data, 'base64'));
}

// 切到双页再看一次
const clicked = await ev(`(()=>{const b=document.querySelector('.docx-modes .pdf-mode');if(!b)return 'no-btn';b.click();return b.textContent})()`);
await sleep(600);
console.log('TOGGLED ' + JSON.stringify(clicked));
console.log('SPREAD ' + await ev(DUMP));

if (shot) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shot, Buffer.from(s.data, 'base64'));
  console.log('SHOT ' + shot);
}
ws.close();
process.exit(0);
