// PDF 预览：单页 / 双页横向翻页，支持方向键、PageUp/PageDown、鼠标滚轮与悬浮箭头。
//
// 几个必须守住的点（都踩过坑）：
//   1) 一次只显示一页（或一个"跨页对"），按容器尺寸等比缩放（contain），
//      绝不用 CSS 的 width:100% 强行拉伸——canvas 的 height 是像素属性，
//      只约束宽度会让画面上下压扁、文字和图片都糊。
//   2) 按 devicePixelRatio 提高渲染分辨率，保证清晰。
//   3) 预渲染相邻页，翻页几乎无等待。
//   4) 双页模式下，翻页步长是 2，末页/首页再翻交回调用方切换文件。

import { postToHost } from './host';
import { mountZoomControl } from './zoom';
import { createPasswordPrompt } from './pdfpass';

type PdfJs = typeof import('pdfjs-dist');
type PdfDoc = any;

let _pdfjs: PdfJs | null = null;
async function pdfjs(): Promise<PdfJs> {
  if (_pdfjs) return _pdfjs;
  const mod: any = await import('pdfjs-dist');
  // @ts-ignore - vite 的 ?url 导入
  const worker: any = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  mod.GlobalWorkerOptions.workerSrc = worker.default || worker;
  _pdfjs = mod as PdfJs;
  return _pdfjs;
}

export interface Pager {
  readonly pageCount: number;
  readonly page: number;
  next(): boolean;   // 已在末尾时返回 false（调用方据此切换到下一个文件）
  prev(): boolean;
  goto(n: number): void;
  destroy(): void;
}

export interface PdfViewerOptions {
  name: string;
  stale: () => boolean;
  /** 已在首页/末页继续翻页：交给调用方切换到上一个 / 下一个文件 */
  onBoundary?: (dir: 1 | -1) => void;
}

const MAX_DPR = 2;      // 渲染分辨率上限，避免超大 PDF 占用过多内存
const PAGE_GAP = 12;    // 双页之间的间隙

// 单页/双页是用户的阅读习惯，跨文件保持
let spreadPref = false;
// 缩放偏好同样跨文件保持：0 = 适应窗口，>0 = 百分比
let zoomPref = 0;

/** 把 pdf.js 抛出的异常翻成能直接给用户看的一句话。 */
function describePdfError(e: any): string {
  const name = e?.name || '';
  const msg = e?.message || String(e);
  if (/已取消输入密码/.test(msg)) return '已取消输入密码';
  if (name === 'PasswordException') return '密码不正确或未提供密码';
  if (name === 'InvalidPDFException') return 'PDF 文件已损坏或格式不正确';
  return msg;
}

export async function renderPdfViewer(
  buf: ArrayBuffer,
  body: HTMLElement,
  bar: HTMLElement,
  opts: PdfViewerOptions
): Promise<Pager | null> {
  const stale = opts.stale;
  const lib = await pdfjs();
  if (stale()) return null;

  // 加密 PDF：pdf.js 通过 onPassword 要密码，密码错时以 reason=2 再回调一次。
  // 在拿到密码之前 getDocument().promise 一直挂着 —— 所以提示层必须画在这个 body 上，
  // 不能等文档打开后再显示。
  const prompt = createPasswordPrompt(body, opts.name);
  let loadingTask: any = null;
  let cancelled = false;
  let pdf: PdfDoc;
  try {
    // 注意：pdf.js 4.x 的 getDocument() 不认 init 里的 onPassword（类型定义和实现都没有），
    // 必须拿到 loadingTask 之后再赋 `onPassword`。赋早了没用、赋晚了会以
    // "No password given" 直接 reject —— 这是实测出来的（见 dev_pdf_pass_test.py）。
    loadingTask = lib.getDocument({ data: buf } as any);
    loadingTask.onPassword = (updatePassword: (v: string | Error) => void, reason: number) => {
      void prompt.ask(reason).then((pwd) => {
        if (pwd == null) {
          // pdf.js 会把"传 Error"再包一层成 PasswordException("No password given")，
          // 原始信息丢了，所以取消状态自己记着，抛错时用这句人话。
          cancelled = true;
          updatePassword(new Error('已取消输入密码'));
        } else {
          updatePassword(pwd);
        }
      });
    };
    pdf = await loadingTask.promise;
  } catch (e: any) {
    prompt.dispose();
    try { loadingTask?.destroy(); } catch { /* 已经废了 */ }
    throw new Error(cancelled ? '已取消输入密码' : describePdfError(e));
  }
  prompt.dispose();
  if (stale()) { try { pdf.destroy(); } catch { } return null; }

  const pageCount: number = pdf.numPages || 0;
  if (pageCount <= 0) { try { pdf.destroy(); } catch { } return null; }

  body.innerHTML = '';

  const viewer = document.createElement('div');
  viewer.className = 'pdf-viewer';

  const stage = document.createElement('div');
  stage.className = 'pdf-stage';
  viewer.appendChild(stage);

  const modes = document.createElement('div');
  modes.className = 'pdf-modes';
  const btnMode = document.createElement('button');
  btnMode.type = 'button';
  btnMode.className = 'pdf-mode';
  modes.appendChild(btnMode);
  viewer.appendChild(modes);

  const btnPrev = document.createElement('button');
  btnPrev.className = 'pdf-nav pdf-prev';
  btnPrev.type = 'button';
  btnPrev.title = '上一页（← / PageUp / 滚轮上滚）';
  btnPrev.textContent = '‹';

  const btnNext = document.createElement('button');
  btnNext.className = 'pdf-nav pdf-next';
  btnNext.type = 'button';
  btnNext.title = '下一页（→ / PageDown / 滚轮下滚）';
  btnNext.textContent = '›';

  viewer.appendChild(btnPrev);
  viewer.appendChild(btnNext);
  body.appendChild(viewer);

  let page = 1;
  let spread = spreadPref;
  let zoom = zoomPref;
  let destroyed = false;
  let sizeKey = '';
  // 1 号页的原始尺寸（CSS px，scale=1）：用于把"适应窗口"换算成百分比
  let baseW = 0, baseH = 0;
  const cache = new Map<string, HTMLCanvasElement>();
  // 同一页正在渲染时复用同一个 promise（show 与预取可能同时要同一页）
  const inflight = new Map<string, Promise<HTMLCanvasElement | null>>();

  const step = () => (spread ? 2 : 1);

  function avail(): { w: number; h: number } {
    const cw = viewer.clientWidth || window.innerWidth || 960;
    const ch = viewer.clientHeight || window.innerHeight || 640;
    // 左右留出箭头按钮的位置，上下留一点边距
    return { w: Math.max(120, cw - 96), h: Math.max(120, ch - 16) };
  }

  function modeKey(): string {
    const a = avail();
    return `${spread ? 'd' : 's'}@${a.w}x${a.h}@${zoom}`;
  }

  /** 当前容器下"适应窗口"对应的百分比（供缩放控件做衔接） */
  function fitPercent(): number {
    if (!baseW || !baseH) return 100;
    const a = avail();
    const maxW = spread ? Math.max(80, (a.w - PAGE_GAP) / 2) : a.w;
    return Math.round(Math.min(maxW / baseW, a.h / baseH) * 100);
  }

  async function renderPage(n: number): Promise<HTMLCanvasElement | null> {
    if (n < 1 || n > pageCount) return null;
    const hit = cache.get(n + sizeKey);
    if (hit) return hit;

    const p = await pdf.getPage(n);
    if (destroyed || stale()) return null;

    const base = p.getViewport({ scale: 1 });
    if (!baseW) { baseW = base.width; baseH = base.height; }
    const a = avail();
    // 双页时每页只能用一半宽度
    const maxW = spread ? Math.max(80, (a.w - PAGE_GAP) / 2) : a.w;
    const fit = Math.min(maxW / base.width, a.h / base.height);
    // zoom > 0 时按百分比渲染（100 = 原始尺寸），此时可在容器内滚动查看
    const factor = zoom > 0 ? zoom / 100 : fit;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const vp = p.getViewport({ scale: factor * dpr });

    const c = document.createElement('canvas');
    c.className = 'pdf-canvas';
    c.width = Math.max(1, Math.floor(vp.width));
    c.height = Math.max(1, Math.floor(vp.height));
    // 显示尺寸全部由 JS 写入，宽高按同一比例算，绝不让 CSS 单独拉伸
    c.style.width = Math.floor(base.width * factor) + 'px';
    c.style.height = Math.floor(base.height * factor) + 'px';

    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, c.width, c.height);

    try { await p.render({ canvasContext: ctx, viewport: vp }).promise; }
    catch { /* 文档销毁时会被取消，忽略 */ }

    if (destroyed || stale()) return null;
    cache.set(n + sizeKey, c);
    return c;
  }

  function pageCanvas(n: number): Promise<HTMLCanvasElement | null> {
    const key = n + sizeKey;
    const hit = cache.get(key);
    if (hit) return Promise.resolve(hit);
    const running = inflight.get(key);
    if (running) return running;
    const t = renderPage(n).finally(() => { inflight.delete(key); });
    inflight.set(key, t);
    return t;
  }

  function updateBar(): void {
    // 保留翻页位置提示（main.ts 追加的 .pb-index）
    const hint = bar.querySelector('.pb-index');
    bar.innerHTML = '';

    const nm = document.createElement('span');
    nm.className = 'pb-name';
    nm.textContent = opts.name;
    bar.appendChild(nm);

    const last = spread ? Math.min(pageCount, page + 1) : page;
    const range = last > page ? `${page}-${last}` : `${page}`;
    const info = document.createElement('span');
    info.textContent = `PDF · 第 ${range} / ${pageCount} 页 · ${spread ? '双页' : '单页'}`
      + ` · ${zoom === 0 ? '适应窗口' : zoom + '%'}`;
    bar.appendChild(info);
    if (hint) bar.appendChild(hint);

    // 底部缩放控件（bar 每次重建都要重新挂载）
    mountZoomControl(bar, {
      value: zoom,
      fitPercent,
      onChange: (v) => {
        if (zoom === v) return;
        zoom = v;
        zoomPref = v;
        cache.clear();
        sizeKey = '';
        show(page);
        postToHost({ type: 'log', message: `PDF 缩放：${v === 0 ? '适应窗口' : v + '%'}` });
      }
    });
  }

  function updateNav(): void {
    const canPrev = page > 1;
    const canNext = page + step() <= pageCount;
    btnPrev.classList.toggle('disabled', !canPrev);
    btnNext.classList.toggle('disabled', !canNext);
    const show = pageCount > 1 || spread;
    btnPrev.style.display = show ? '' : 'none';
    btnNext.style.display = show ? '' : 'none';
  }

  // 渲染批次串行执行：排队的请求只保留最后一个。
  // 以前是并发 show()，先到的那个把 stage 清空、后到的那个只画了一半，
  // 表现为"双页模式只剩一页 / 翻页时闪白"。
  let running = false;
  let pending: number | null = null;
  // 首批渲染完成信号：确保"首次渲染"和"尺寸观察触发的重排"不会并发
  let firstDone: (() => void) | null = null;
  const firstReady = new Promise<void>((r) => { firstDone = r; });

  function show(n: number): void {
    pending = n;
    if (!running) void drainShow();
  }

  async function drainShow(): Promise<void> {
    running = true;
    try {
      while (pending != null) {
        const n = pending;
        pending = null;
        await renderSpread(n);
        if (destroyed || stale()) break;
      }
    } finally {
      running = false;
      if (firstDone) { const r = firstDone; firstDone = null; r(); }
    }
  }

  async function renderSpread(n: number): Promise<void> {
    if (n < 1 || n > pageCount) return;
    // 双页模式固定以奇数页为左页：1-2 / 3-4 / 5-6 …
    if (spread && n % 2 === 0) n -= 1;
    page = Math.max(1, Math.min(pageCount, n));

    const key = modeKey();
    if (key !== sizeKey) { sizeKey = key; cache.clear(); }

    const list = spread
      ? [page, page + 1].filter((x) => x >= 1 && x <= pageCount)
      : [page];

    updateBar();
    updateNav();

    // 先把这一批全部渲染完，再一次性替换 DOM：中途不会出现"清空后只有半页"
    const canvases: HTMLCanvasElement[] = [];
    for (const idx of list) {
      const c = await pageCanvas(idx);
      if (destroyed || stale()) return;
      if (c) canvases.push(c);
    }
    if (!canvases.length) return;

    stage.replaceChildren(...canvases);
    // 换页后回到页首：放大查看时上一页的滚动位置若保留下来，
    // 新页会停在半截，看起来像"翻页没生效"
    viewer.scrollTop = 0;
    viewer.scrollLeft = 0;

    // 预渲染：下一组 / 上一组（双页时是两页）
    for (const t of [page + step(), page - step()]) {
      if (t >= 1 && t <= pageCount) void pageCanvas(t);
    }
  }

  let resizeTimer = 0;
  let ro: ResizeObserver | null = null;

  const pager: Pager = {
    get pageCount() { return pageCount; },
    get page() { return page; },
    next(): boolean {
      const n = page + step();
      if (n > pageCount) return false;
      show(n);
      return true;
    },
    prev(): boolean {
      const n = page - step();
      if (n < 1) return false;
      show(n);
      return true;
    },
    goto(n: number): void {
      show(Math.max(1, Math.min(pageCount, n)));
    },
    destroy(): void {
      destroyed = true;
      pending = null;
      if (ro) ro.disconnect();
      window.clearTimeout(resizeTimer);
      cache.clear();
      inflight.clear();
      try { pdf.destroy(); } catch { }
    }
  };

  // ---------- 单页 / 双页切换 ----------
  function syncModeButton(): void {
    btnMode.textContent = spread ? '双页' : '单页';
    btnMode.classList.toggle('active', spread);
    btnMode.title = spread ? '当前：双页浏览（点击切换为单页）' : '当前：单页浏览（点击切换为双页）';
  }
  syncModeButton();

  btnMode.addEventListener('click', (e) => {
    e.stopPropagation();
    spread = !spread;
    spreadPref = spread;
    cache.clear();
    sizeKey = '';
    syncModeButton();
    show(page);
    postToHost({ type: 'log', message: `PDF 切换为${spread ? '双页' : '单页'}浏览` });
  });

  btnPrev.addEventListener('click', (e) => { e.stopPropagation(); pager.prev(); });
  btnNext.addEventListener('click', (e) => { e.stopPropagation(); pager.next(); });

  // ---------- 鼠标滚轮翻页 ----------
  // PDF 是横向分页的，纵向滚轮没有可滚动的区域，直接映射成翻页最符合直觉。
  // 一次滚轮事件序列（触控板会连发几十个）只翻一页，用时间锁 + 累计阈值限流。
  let wheelAcc = 0;
  let wheelUntil = 0;
  viewer.addEventListener('wheel', (e: WheelEvent) => {
    if (destroyed) return;

    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const canY = viewer.scrollHeight > viewer.clientHeight + 2;
    const canX = viewer.scrollWidth > viewer.clientWidth + 2;
    // 横向溢出（放大后页面比窗口宽）先交给原生横向滚动，滚轮不翻页
    if (canX) return;
    if (canY) {
      // 纵向还能看就滚；剩余不足 1/5 屏时翻页 —— 否则放大后滚到页底会卡死，
      // 只能拖滚动条才能换页（和 Word 视图的坑一样）。
      const near = Math.max(100, viewer.clientHeight * 0.2);
      const remainDown = viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop;
      const remainUp = viewer.scrollTop;
      if (dy > 0 ? remainDown > near : remainUp > near) return;
    }

    e.preventDefault();

    const now = Date.now();
    if (now < wheelUntil) return;

    wheelAcc += dy;
    if (Math.abs(wheelAcc) < 24) return;

    const dir: 1 | -1 = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    wheelUntil = now + 130;

    const moved = dir > 0 ? pager.next() : pager.prev();
    if (!moved && opts.onBoundary) opts.onBoundary(dir);
  }, { passive: false });

  // ---------- 尺寸变化重排 ----------
  ro = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (destroyed || stale()) return;
      const key = modeKey();
      if (key === sizeKey) return;      // 尺寸没变（例如首次布局），不必重排
      cache.clear();
      sizeKey = key;
      show(page);
    }, 150);
  });
  ro.observe(viewer);

  show(1);
  await firstReady;
  if (stale()) { pager.destroy(); return null; }

  const shown = stage.querySelector('canvas') as HTMLCanvasElement | null;
  postToHost({
    type: 'log',
    message: `PDF 就绪：${pageCount} 页（${spread ? '双页' : '单页'}横向翻页）`
      + (shown ? `，首页显示 ${shown.style.width}×${shown.style.height}` : '')
  });
  return pager;
}
