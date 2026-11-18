// 对比「迷你包首屏」与「整篇换装后」的第 1 页结构，回答一个问题：
// 第 1 页在用户眼皮底下到底有没有变（几何一样但内容变了同样算"刷新了一下"）。
//
// 用法：先启动带 CDP 的预览，再 `node dev_page1_snapshot.mjs [--port 9223] [--hold 12]`
import http from 'node:http';

const argv = process.argv.slice(2);
let port = 9223, hold = 12;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--hold') hold = Number(argv[++i]);
}
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
    target = list.find((t) => t.type === 'page' && /app\.local/.test(t.url));
  } catch { /* 还没起来 */ }
  if (!target) await sleep(250);
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

// 只看 .docx-stage 里的 wrapper：document 级的 querySelector 会抓到离屏容器里的半成品
const EXPR = `(() => {
  const w = document.querySelector('.docx-stage .docx-preview-wrapper');
  if (!w) return '{}';
  const st = document.querySelector('.docx-stage');
  if (!st || getComputedStyle(st).visibility !== 'visible') return '{}';
  const secs = Array.from(w.querySelectorAll(':scope > section'));
  const d = (s) => {
    const a = s.querySelector(':scope > article');
    const kids = a ? Array.from(a.children) : [];
    return {
      h: s.offsetHeight,
      min: getComputedStyle(s).minHeight,
      chars: (s.innerText || '').replace(/\\s+/g, ' ').length,
      imgs: Array.from(s.querySelectorAll('img')).filter((i) => i.complete && i.naturalWidth > 0).length,
      head: (s.innerText || '').replace(/\\s+/g, ' ').slice(0, 24),
      kids: kids.slice(0, 8).map((k) => k.tagName + '/' + Math.round(k.getBoundingClientRect().height))
    };
  };
  return JSON.stringify({ n: secs.length, s0: d(secs[0]), s1: secs[1] ? d(secs[1]) : null }, null, 1);
})()`;

let first = null;
const t0 = Date.now();
while (Date.now() - t0 < 25000 && !first) {
  const v = await evaluate(EXPR);
  if (v && v !== '{}') first = v;
  else await sleep(100);
}
console.log(`=== 首次可见（${Date.now() - t0}ms）===\n${first}`);
await sleep(hold * 1000);
const last = await evaluate(EXPR);
console.log(`=== 稳定后 ===\n${last}`);
const a = first ? JSON.parse(first) : null;
const b = last ? JSON.parse(last) : null;
const same = a && b && JSON.stringify(a.s0) === JSON.stringify(b.s0);
console.log(same ? '\nPASS 第 1 页结构完全一致' : '\nFAIL 第 1 页结构变了（用户会觉得"刷新了一下"）');
ws.close();
