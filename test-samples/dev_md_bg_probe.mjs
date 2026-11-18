// 量 Markdown 长文档的背景几何：白纸是否一直铺到文末。
//
// 用法：
//   chrome --headless=new --remote-debugging-port=9333 <repro.html>
//   node test-samples/dev_md_bg_probe.mjs [--port 9333] [--out top.png] [--scroll]
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let port = 9333, out = '', scroll = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--out') out = argv[++i];
  else if (argv[i] === '--scroll') scroll = true;
}

const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list = [];
for (let i = 0; i < 20; i++) {
  try { list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`)); } catch { list = []; }
  if (list.some((t) => t.type === 'page')) break;
  await sleep(300);
}
const target = list.find((t) => t.type === 'page');
if (!target) { console.error('没有页面 target'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params) {
  const id = ++seq;
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

const MEASURE = `(() => {
  const pb = document.querySelector('.preview-body');
  const mv = document.querySelector('.md-view');
  const mb = document.querySelector('.md-body');
  if (!pb || !mv || !mb) return { error: 'missing' };
  const r = (e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) }; };
  const last = mb.lastElementChild;
  return {
    pbClientH: pb.clientHeight,
    pbScrollH: pb.scrollHeight,
    mdView: r(mv),
    mdBody: r(mb),
    mdBodyScrollH: mb.scrollHeight,
    lastChildTop: last ? Math.round(last.getBoundingClientRect().top) : null,
    // md-body 盒子底边到内容底边的差 = 背景缺失的高度
    gapBelowBody: last ? Math.round(last.getBoundingClientRect().bottom - mb.getBoundingClientRect().bottom) : null
  };
})()`;

if (scroll) {
  await evaluate(`(() => { const pb = document.querySelector('.preview-body'); pb.scrollTop = pb.scrollHeight; return pb.scrollTop; })()`);
  await sleep(400);
}

const m = await evaluate(MEASURE);
console.log(JSON.stringify(m, null, 2));

if (out) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot ->', out);
}
ws.close();
