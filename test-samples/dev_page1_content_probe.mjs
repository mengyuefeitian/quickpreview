// 采样「第 1 页的内容在首屏之后有没有变」——几何不变但内容变了，用户同样会觉得"刷新了一下"
// （迷你包少了图片/页眉，整篇换装后补上）。
import http from 'node:http';

const argv = process.argv.slice(2);
let port = 9223, untilSec = 16;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--until') untilSec = Number(argv[++i]);
}
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40; i++) {
  try {
    const list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
    target = list.find((t) => t.type === 'page' && /app\.local/.test(t.url));
    if (target) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!target) { console.log('连不上 CDP'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const evaluate = (expr) => new Promise((res) => {
  const my = ++id;
  pending.set(my, (m) => res(m.result?.result?.value));
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
});

const PROBE = `(() => {
  const st = document.querySelector('.docx-stage');
  const vis = st && getComputedStyle(st).visibility === 'visible';
  const secs = st ? Array.from(st.querySelectorAll(':scope .docx-preview-wrapper > section')) : [];
  const p1 = secs[0];
  if (!p1) return JSON.stringify({ vis, none: true });
  const t = (p1.innerText || '').replace(/\\s+/g, ' ').trim();
  return JSON.stringify({
    vis,
    chars: t.length,
    head: t.slice(0, 30),
    imgs: p1.querySelectorAll('img').length,
    imgsLoaded: Array.from(p1.querySelectorAll('img')).filter((i) => i.complete && i.naturalWidth > 0).length,
    h: Math.round(p1.getBoundingClientRect().height)
  });
})()`;

const t0 = Date.now();
let firstSeen = null;
let prev = null;
const seen = new Set();
while (Date.now() - t0 < untilSec * 1000) {
  const raw = await evaluate(PROBE);
  let v = null;
  try { v = JSON.parse(raw); } catch { /* ignore */ }
  if (v && v.vis && !v.none) {
    const key = `${v.chars}|${v.imgs}|${v.imgsLoaded}|${v.h}|${v.head}`;
    if (key !== prev) {
      prev = key;
      const t = Date.now() - t0;
      if (!firstSeen) firstSeen = t;
      seen.add(key);
      console.log(`${String(t).padStart(6)}ms  字${v.chars} 图${v.imgsLoaded}/${v.imgs} 高${v.h} | ${v.head}`);
    }
  }
  await sleep(120);
}
console.log(`\n第 1 页出现：${firstSeen ?? '-'}ms，不同的样子共 ${seen.size} 种`);
console.log(seen.size <= 1 ? 'PASS 第 1 页出现后内容没有再变' : 'FAIL 第 1 页内容在首屏之后变过');
ws.close();
