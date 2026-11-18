// 探测「大文档加载期间界面是否还活着」。
//
// 背景：30MB / 上千页的 docx 渲染要几十秒，旧实现全程同步占住 JS 主线程，
// 界面一直停在「解析文档…」、右上角 × 点了没反应（点击全排到渲染结束才执行）。
// 这个脚本连 CDP，每 700ms 读一次加载提示并记录「读一次花了多久」：
//   · 文案在变 ⇒ 阶段进度真的在推进
//   · 每次 evaluate 都能在几百毫秒内返回 ⇒ 主线程有让出，按钮点得动
//
// 用法：
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
//   QP_BROWSER_ARGS=--disable-gpu ./publish/QuickPreview.exe --preview <docx> --quiet
//   node test-samples/dev_load_probe.mjs [--port 9222] [--max 90] [--click "关闭选择器" --at 8000]
import http from 'node:http';

const argv = process.argv.slice(2);
let port = 9222, maxSec = 90, clickSel = '', clickAt = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--max') maxSec = Number(argv[++i]);
  else if (argv[i] === '--click') clickSel = argv[++i];
  else if (argv[i] === '--at') clickAt = Number(argv[++i]);
}

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list = [], target = null;
for (let i = 0; i < 60; i++) {
  try { list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`)); } catch { list = []; }
  target = list.find((t) => t.type === 'page' && String(t.url).includes('app.local'));
  if (target) break;
  await sleep(500);
}
if (!target) { console.error('没有 app.local 页面：' + JSON.stringify(list.map((t) => t.url))); process.exit(1); }

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
  if (r && r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r && r.result ? r.result.value : undefined;
};

const t0 = Date.now();
let prev = '';
let lastPhase = '';
let clicked = false;

for (let i = 0; i < maxSec; i++) {
  const s = Date.now();
  const state = await ev(`(()=>{
    const l = document.querySelector('.loading');
    const bar = document.querySelector('.preview-bar');
    return JSON.stringify({
      loading: l ? l.textContent : '',
      bar: bar ? bar.innerText.replace(/\\s+/g,' ').slice(0,80) : ''
    });
  })()`);
  const cost = Date.now() - s;
  const t = ((Date.now() - t0) / 1000).toFixed(1);

  let loading = '', bar = '';
  try { const o = JSON.parse(state); loading = o.loading; bar = o.bar; } catch { loading = String(state); }

  // 只在文案变化时打一行，避免刷屏；evaluate 耗时超过 1 秒要单独标出来（说明主线程被占）
  if (loading !== prev) {
    console.log(`[${t}s] 阶段=${loading || '(无加载提示)'}${bar ? ' | 状态栏=' + bar : ''}  eval=${cost}ms`);
    prev = loading;
    lastPhase = loading;
  } else if (cost > 1000) {
    console.log(`[${t}s] ${loading || '(渲染中)'}  eval 耗时 ${cost}ms（主线程被占住这么久）`);
  }

  if (clickSel && !clicked && Date.now() - t0 >= clickAt) {
    clicked = true;
    const r = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(clickSel)});if(!el)return 'no-element';el.click();return 'clicked';})()`);
    console.log(`[${t}s] 点击 ${clickSel} → ${r}，观察 4 秒内是否关窗`);
    await sleep(4000);
    let alive = 'unknown';
    try {
      const st = await Promise.race([
        ev(`document.readyState`),
        sleep(1500).then(() => 'timeout')
      ]);
      alive = st === 'timeout' ? '页面未响应' : '页面仍在（' + st + '）';
    } catch { alive = '连接已断（窗口多半已关）'; }
    console.log(`[${t}s] 点击后状态：${alive}`);
    break;
  }

  if (!loading && bar && /Word|页/.test(bar)) {
    console.log(`[${t}s] 渲染完成：${bar}`);
    break;
  }
  await sleep(700);
}
ws.close();
