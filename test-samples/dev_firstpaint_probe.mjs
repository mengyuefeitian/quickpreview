// 采样「第一眼之后布局还会不会跳」。
//
// 用户的原话是「打开先展示一个首页，然后 1 秒左右又明显的刷新一下」。
// 那次跳变的可观测特征有四个，任何一个变了用户就会看到"刷新"：
//   zoom        100% → 适应窗口（整篇缩放）
//   dir         column → row（纵向堆叠变横向单页）
//   visibleN    同时可见 200+ 页 → 只剩 1 页
//   firstRect   第 1 页的位置/尺寸
// 本脚本每 150ms 采一次，只在数值变化时打印一行，最后给一句判定。
//
// 用法：
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
//     ./publish/QuickPreview.exe --preview <docx> --quiet &
//   node test-samples/dev_firstpaint_probe.mjs [--port 9222] [--until 12]
import http from 'node:http';

const argv = process.argv.slice(2);
let port = 9222, untilSec = 12;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--until') untilSec = Number(argv[++i]);
}
const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40; i++) {
  try {
    const list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
    target = list.find((t) => t.type === 'page' && String(t.url).includes('app.local'));
  } catch { /* 还没起来 */ }
  if (target) break;
  await sleep(250);
}
if (!target) { console.error('连不上 CDP'); process.exit(1); }

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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) return { err: (r.exceptionDetails.exception?.description || '').slice(0, 120) };
  return r.result.value;
};

const PROBE = `(() => {
  const st = document.querySelector('.docx-stage');
  const stEl = document.querySelector('.docx-stage');
  const wr = document.querySelector('.docx-stage .docx-preview-wrapper');
  const kids = wr ? Array.from(wr.children).filter(c => c.tagName === 'SECTION') : [];
  const vis = kids.filter(s => s.style.visibility !== 'hidden' && s.style.position !== 'absolute');
  const f = vis[0];
  const r = f ? f.getBoundingClientRect() : null;
  const bar = document.querySelector('.preview-bar');
  return {
    zoom: st ? (st.style.zoom || '1') : '-',
    stageVis: st ? getComputedStyle(st).visibility : '-',
    dir: wr ? getComputedStyle(wr).flexDirection : '-',
    pages: kids.length,
    visN: vis.length,
    rect: r ? Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : '-',
    loading: (document.querySelector('.loading') || {}).textContent || '',
    bar: bar ? bar.textContent.replace(/\\s+/g, ' ').slice(0, 46) : ''
  };
})()`;

const t0 = Date.now();
let prev = '';
let firstContentAt = 0;
const snapshots = [];
while (Date.now() - t0 < untilSec * 1000) {
  const s = await ev(PROBE);
  if (!s || s.err) { await sleep(150); continue; }
  const ms = Date.now() - t0;
  const key = JSON.stringify(s);
  if (key !== prev) {
    prev = key;
    const line = `  ${String(ms).padStart(5)}ms  zoom=${String(s.zoom).padEnd(6)} dir=${String(s.dir).padEnd(7)}`
      + ` pages=${String(s.pages).padStart(3)} vis=${String(s.visN).padStart(3)} rect=${s.rect}`
      + ` stage=${s.stageVis} | ${s.loading ? '加载:' + s.loading.slice(0, 18) : s.bar.slice(0, 40)}`;
    console.log(line);
    snapshots.push({ ms, ...s });
    if (!firstContentAt && s.pages > 0 && s.visN > 0 && s.stageVis === 'visible') firstContentAt = ms;
  }
  await sleep(150);
}

// 判定：第一眼出现之后，zoom / dir / 第 1 页位置都不该再变
const after = snapshots.filter((s) => firstContentAt && s.ms >= firstContentAt);
const zooms = new Set(after.map((s) => s.zoom));
const dirs = new Set(after.map((s) => s.dir));
const rects = new Set(after.map((s) => s.rect));
console.log('');
console.log(`首屏出现：${firstContentAt || '-'}ms`);
console.log(`之后采样 ${after.length} 次，zoom 变化 ${zooms.size} 种，dir 变化 ${dirs.size} 种，第1页位置 ${rects.size} 种`);
const clean = zooms.size <= 1 && dirs.size <= 1 && rects.size <= 2;
console.log(clean ? 'PASS 第一眼之后布局没有再跳（只有页数/文字在变）' : 'FAIL 第一眼之后还有布局变化 —— 用户会看到刷新感');
ws.close();
process.exit(clean ? 0 : 1);
