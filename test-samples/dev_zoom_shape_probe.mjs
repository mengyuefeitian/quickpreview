// 一次性诊断：确认 CSS zoom 对 section 的 offsetHeight / 折行到底有没有影响。
// 用法：node dev_zoom_shape_probe.mjs [--port 9223] [--sec 0]
import http from 'node:http';

const argv = process.argv.slice(2);
let port = 9223, secIdx = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--sec') secIdx = Number(argv[++i]);
}
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 80 && !target; i++) {
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
  pending.set(my, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails?.text));
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
});

const EXPR = `(() => {
  const stage = document.querySelector('.docx-stage');
  const w = stage && stage.querySelector('.docx-preview-wrapper');
  if (!w) return JSON.stringify({ err: 'no wrapper' });
  const secs = Array.from(w.querySelectorAll(':scope > section'));
  const s = secs[${secIdx}];
  if (!s) return JSON.stringify({ err: 'no section', n: secs.length });
  const cs = getComputedStyle(s);
  const snap = (tag) => {
    const a = s.querySelector(':scope > article');
    const kids = a ? Array.from(a.children) : [];
    const r = s.getBoundingClientRect();
    return {
      tag,
      zoom: stage.style.zoom || '(空=1)',
      offH: s.offsetHeight,
      rectH: Math.round(r.height * 100) / 100,
      rectW: Math.round(r.width * 100) / 100,
      minH: cs.minHeight,
      padT: cs.paddingTop,
      padB: cs.paddingBottom,
      styleW: s.style.width,
      artW: Math.round((a ? a.getBoundingClientRect().width : 0) * 100) / 100,
      n: kids.length,
      chars: (s.innerText || '').replace(/\\s+/g, ' ').length,
      kidH: kids.slice(0, 10).map((k) => Math.round(k.getBoundingClientRect().height)),
      wrapW: Math.round(w.getBoundingClientRect().width * 100) / 100,
      stageW: Math.round(stage.getBoundingClientRect().width * 100) / 100,
      innerW: Math.round(stage.clientWidth * 100) / 100
    };
  };
  const out = [snap('as-is')];
  const prev = stage.style.zoom;
  stage.style.zoom = '1';
  out.push(snap('zoom=1'));
  stage.style.zoom = prev;
  out.push(snap('restored'));
  return JSON.stringify({ nsec: secs.length, out });
})()`;

// 等加载真的结束（没有 .loading 文案）
for (let i = 0; i < 200; i++) {
  const busy = await evaluate(`(() => {
    const l = document.querySelector('.loading');
    return l && getComputedStyle(l).display !== 'none' ? (l.innerText || '?') : '';
  })()`);
  if (!busy) break;
  await sleep(300);
}
await sleep(1500);
console.log(await evaluate(EXPR));
ws.close();
