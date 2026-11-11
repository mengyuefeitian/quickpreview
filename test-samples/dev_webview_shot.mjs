// 真机 WebView2 抓「某一页」的截图（走 CDP，不需要鼠标键盘）。
//
// 为什么单独写一个：本机 WebView2 每次启动要 5~6 秒，且宿主是常驻单实例，
// 手动开预览只能看到第一页。这个脚本自己拉起 exe（带远程调试端口），
// 用方向键事件翻到目标页，截图后把进程收掉 —— 一条命令拿到「docx 第 N 页长什么样」。
//
// 用法：
//   node test-samples/dev_webview_shot.mjs --file <文档> --find "<页面里的标志文字>" --shot out.png [--max 400]
//
// 参数：
//   --exe   程序路径，默认 dotnet/QuickPreview/bin/Release/net8.0-windows/win-x64/QuickPreview.exe
//   --file  要预览的文件
//   --find  目标页里必然出现的一段文字（用于判断翻到了没）
//   --shot  截图输出路径
//   --max   最多翻多少页，默认 400
//   --port  调试端口，默认 9222
//   --eval  额外执行一段 JS 并打印结果（可多次）
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = {
  exe: 'dotnet/QuickPreview/bin/Release/net8.0-windows/win-x64/QuickPreview.exe',
  file: '', find: '', shot: '', max: 400, port: 9222, evals: [],
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--exe') opt.exe = argv[++i];
  else if (a === '--file') opt.file = argv[++i];
  else if (a === '--find') opt.find = argv[++i];
  else if (a === '--shot') opt.shot = argv[++i];
  else if (a === '--max') opt.max = Number(argv[++i]);
  else if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--eval') opt.evals.push(argv[++i]);
}
if (!opt.file) { console.error('缺少 --file'); process.exit(2); }
if (!existsSync(opt.exe)) { console.error('找不到 exe：' + opt.exe); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单实例互斥体：先让已有实例退出，否则新进程只会弹「已在运行」然后退出
spawn('taskkill', ['/F', '/IM', 'QuickPreview.exe'], { stdio: 'ignore' });
await sleep(1500);

const child = spawn(opt.exe, ['--preview', opt.file, '--quiet'], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${opt.port}`,
    QP_BROWSER_ARGS: '--disable-gpu',   // 本机无显卡，关掉 GPU 才能稳定渲染
  },
  stdio: 'ignore',
  detached: false,
});

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => res(d));
  }).on('error', rej);
});

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = JSON.parse(await get(`http://127.0.0.1:${opt.port}/json/list`));
    target = list.find((t) => t.type === 'page' && String(t.url).includes('app.local'));
    if (target) break;
  } catch { /* 端口还没起来 */ }
  await sleep(500);
}
if (!target) { console.error('CDP_TARGET_NOT_FOUND'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

// 等页面把 Word 渲染完（底部栏出现「Word ·」）
for (let i = 0; i < 120; i++) {
  const bar = await evalJs(`(()=>{const b=document.querySelector('.preview-bar');return b?b.innerText:''})()`);
  if (typeof bar === 'string' && /Word|PDF|图片|页/.test(bar)) break;
  await sleep(500);
}

const find = JSON.stringify(opt.find || '');
const diag = await evalJs(`(()=>{
  const secs = [...document.querySelectorAll('.docx-viewer section')];
  const vis = secs.filter(s => s.style.visibility !== 'hidden');
  return { sections: secs.length, visible: vis.length,
           shown: vis.map(s => (s.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)) };
})()`);
console.log('DIAG ' + JSON.stringify(diag));
const reached = await evalJs(`(async()=>{
  const find = ${find};
  // 只认预览区里的页面：外壳里还有一个空状态 <section>（"选中文件后按空格预览"），
  // 它没有被 paintPages 加过 visibility，会被误判成"当前页"。
  const visible = () => [...document.querySelectorAll('.docx-viewer section')].find(s => s.style.visibility !== 'hidden');
  const hit = () => !!visible() && visible().textContent.includes(find);
  if (!find) return 'no-find';
  for (let i = 0; i < ${opt.max}; i++) {
    if (hit()) return 'ok@' + i;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
  }
  return 'notfound';
})()`);

const bar = await evalJs(`(()=>{const b=document.querySelector('.preview-bar');return b?b.innerText.replace(/\\n/g,' | '):'-'})()`);
const footer = await evalJs(`(()=>{const s=[...document.querySelectorAll('.docx-viewer section')].find(x=>x.style.visibility!=='hidden');const f=s&&s.querySelector('footer');return f?f.textContent.replace(/\\s+/g,' ').trim():'-'})()`);
console.log('REACHED ' + JSON.stringify(reached));
console.log('BAR ' + JSON.stringify(bar));
console.log('FOOTER ' + JSON.stringify(footer));

for (const expr of opt.evals) {
  const v = await evalJs(expr);
  console.log('EVAL ' + (typeof v === 'string' ? v : JSON.stringify(v)));
}

if (opt.shot) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(opt.shot, Buffer.from(shot.data, 'base64'));
  console.log('SHOT ' + opt.shot);
}

ws.close();
child.kill();
await sleep(500);
spawn('taskkill', ['/F', '/IM', 'QuickPreview.exe'], { stdio: 'ignore' });
process.exit(0);
