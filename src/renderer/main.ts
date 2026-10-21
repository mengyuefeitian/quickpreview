import './styles/style.css';
import { renderPreview, cancelRender, currentPager, setPagerBoundaryHandler } from './lib/preview';
import { formatBytes } from './lib/util';
import { isWebView2, postToHost, onHostMessage } from './lib/host';
import { extOf, categoryOfPath } from '../shared/mime';
import type { FileItem, Category } from '../shared/types';

const $ = (id: string) => document.getElementById(id)!;

const sidebar = $('sidebar');
const listEl = $('file-list');
const emptyTip = $('empty-tip');
const countEl = $('count');
const pane = $('preview-pane');
const body = $('preview-body');
const bar = $('preview-bar');
const chromeTitle = $('chrome-title');
const chromeIcon = $('chrome-icon');

// 服务模式：由 C# 宿主驱动（资源管理器选中文件 → 空格 → 收到 open 消息）
const serviceMode = isWebView2;

if (serviceMode) {
  document.body.classList.add('overlay');
  (window as any).__qpService = true;
}

// ---------- 页面异常回传宿主（写入 web.log / error.log） ----------
function hostLog(msg: string): void {
  postToHost({ type: 'log', message: msg });
}

function hostError(msg: string): void {
  postToHost({ type: 'error', message: msg });
}

window.addEventListener('error', (e: ErrorEvent) => {
  hostError(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});

window.addEventListener('unhandledrejection', (e: any) => {
  const r = e.reason;
  hostError('unhandledrejection: ' + (r?.stack || r?.message || String(r)));
});

let list: FileItem[] = [];
let sel = 0;
let open = false;

// ---------- 类别图标 ----------
function iconOf(item: FileItem): { label: string; color: string } {
  const ext = item.ext;
  const map: Record<string, { label: string; color: string }> = {
    png: { label: 'IMG', color: '#3aa675' }, jpg: { label: 'IMG', color: '#3aa675' },
    jpeg: { label: 'IMG', color: '#3aa675' }, jpe: { label: 'IMG', color: '#3aa675' },
    jfif: { label: 'IMG', color: '#3aa675' }, gif: { label: 'IMG', color: '#3aa675' },
    bmp: { label: 'IMG', color: '#3aa675' }, webp: { label: 'IMG', color: '#3aa675' },
    pdf: { label: 'PDF', color: '#d9534f' },
    docx: { label: 'DOC', color: '#2f6fb0' }, docm: { label: 'DOC', color: '#2f6fb0' },
    doc: { label: 'DOC', color: '#2f6fb0' },
    xlsx: { label: 'XLS', color: '#1f8a4c' }, xlsm: { label: 'XLS', color: '#1f8a4c' },
    xls: { label: 'XLS', color: '#1f8a4c' }, csv: { label: 'CSV', color: '#1f8a4c' },
    pptx: { label: 'PPT', color: '#d9772b' }, pptm: { label: 'PPT', color: '#d9772b' },
    ppt: { label: 'PPT', color: '#d9772b' },
    zip: { label: 'ZIP', color: '#8a7bd1' },
    mp3: { label: 'AUD', color: '#b084d1' }, flac: { label: 'AUD', color: '#b084d1' },
    wav: { label: 'AUD', color: '#b084d1' }, ape: { label: 'AUD', color: '#b084d1' },
    ogg: { label: 'AUD', color: '#b084d1' }, m4a: { label: 'AUD', color: '#b084d1' },
    aac: { label: 'AUD', color: '#b084d1' },
    mp4: { label: 'VID', color: '#e0a84e' }, mkv: { label: 'VID', color: '#e0a84e' },
    avi: { label: 'VID', color: '#e0a84e' }, mov: { label: 'VID', color: '#e0a84e' },
    webm: { label: 'VID', color: '#e0a84e' }, wmv: { label: 'VID', color: '#e0a84e' }
  };
  if ((item.category as Category) === 'folder') return { label: 'DIR', color: '#e0a84e' };
  if (map[ext]) return map[ext];
  if ((item.category as Category) === 'text') return { label: 'TXT', color: '#6a9bd1' };
  return { label: '?', color: '#777' };
}

// ---------- 列表渲染 ----------
function renderList(): void {
  listEl.innerHTML = '';
  emptyTip.style.display = list.length ? 'none' : 'block';
  countEl.textContent = list.length ? `共 ${list.length} 个文件` : '';
  list.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'file-item' + (i === sel ? ' active' : '');
    li.dataset.index = String(i);
    const ic = iconOf(item);
    const icon = document.createElement('div');
    icon.className = 'fi-icon';
    icon.style.background = ic.color;
    icon.textContent = ic.label;
    const meta = document.createElement('div');
    meta.className = 'fi-meta';
    const name = document.createElement('div');
    name.className = 'fi-name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'fi-sub';
    sub.textContent = '.' + item.ext + (item.size ? ' · ' + formatBytes(item.size) : '');
    meta.appendChild(name);
    meta.appendChild(sub);
    li.appendChild(icon);
    li.appendChild(meta);
    li.addEventListener('click', () => { selectIndex(i); openPreview(); });
    li.addEventListener('dblclick', () => { selectIndex(i); openPreview(); });
    listEl.appendChild(li);
  });
}

function updateActive(): void {
  Array.from(listEl.children).forEach((c, i) => {
    c.classList.toggle('active', i === sel);
    if (i === sel) (c as HTMLElement).scrollIntoView({ block: 'nearest' });
  });
}

// ---------- 窗口标题栏（文件名 / 图标 / 关闭 / 默认程序打开） ----------
let currentApp: string | null = null;   // 当前文件默认由哪个程序打开（"Word"/"Excel"/…）

function updateChrome(): void {
  if (!serviceMode) return;
  const it = open && list.length ? list[sel] : null;

  const btnOpen = $('chrome-open');
  if (!it) {
    chromeTitle.textContent = 'QuickPreview';
    chromeTitle.title = '';
    chromeIcon.textContent = '␣';
    chromeIcon.style.background = '#3a5f8f';
    btnOpen.textContent = '用默认程序打开';
    return;
  }

  chromeTitle.textContent = it.name;
  chromeTitle.title = it.path;
  const ic = iconOf(it);
  chromeIcon.textContent = ic.label;
  chromeIcon.style.background = ic.color;

  // 按钮文案跟随系统默认程序：使用 Word 打开 / 使用 Excel 打开 / 使用 照片 打开…
  btnOpen.textContent = currentApp ? `使用 ${currentApp} 打开` : '用默认程序打开';
  btnOpen.title = (currentApp ? `使用 ${currentApp}` : '使用系统默认程序') + '打开，预览会关闭';
}

$('chrome-open').addEventListener('click', () => {
  const it = list[sel];
  if (!it) return;
  hostLog(`用默认程序打开：${it.path}`);
  postToHost({ type: 'openExternal', path: it.path });
  // 宿主会立刻关闭预览浮层，这里同步清掉渲染内容，避免下次打开前闪一下旧文件
  closePreview();
});

$('chrome-close').addEventListener('click', () => {
  closePreview();
  if (serviceMode) postToHost({ type: 'requestClose' });
});

// ---------- 窗口移动 / 缩放 ----------
// 宿主是无边框窗体（FormBorderStyle.None），既没有系统标题栏可拖、也没有边框可拉。
// 这里由前端判断鼠标位置/按住的是哪块区域，把"要移动"或"要往哪个方向缩放"告诉宿主，
// 宿主用 Cursor.Position 实时改 Bounds（数值与 C# 的 HT_* 常量一一对应）。
const HT_CAPTION = 2, HT_LEFT = 10, HT_RIGHT = 11, HT_BOTTOM = 15,
      HT_BOTTOMLEFT = 16, HT_BOTTOMRIGHT = 17;
const EDGE = 6;          // 边缘感应宽度（px）

function edgeAt(x: number, y: number): number {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // 顶边不做缩放：顶部那几像素就是标题栏，留给拖动，否则用户很难抓住窗口
  const L = x <= EDGE, R = x >= w - EDGE, B = y >= h - EDGE;
  if (B && L) return HT_BOTTOMLEFT;
  if (B && R) return HT_BOTTOMRIGHT;
  if (L) return HT_LEFT;
  if (R) return HT_RIGHT;
  if (B) return HT_BOTTOM;
  return 0;
}

function cursorFor(edge: number): string {
  switch (edge) {
    case HT_LEFT:
    case HT_RIGHT: return 'ew-resize';
    case HT_BOTTOM: return 'ns-resize';
    case HT_BOTTOMLEFT:
    case HT_BOTTOMRIGHT: return 'nesw-resize';
    default: return '';
  }
}

let winDragging = false;

if (serviceMode) {
  document.addEventListener('pointermove', (e) => {
    if (winDragging) return;
    const edge = edgeAt(e.clientX, e.clientY);
    document.body.style.cursor = cursorFor(edge);
  }, true);

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;

    const edge = edgeAt(e.clientX, e.clientY);
    if (edge) {
      e.preventDefault();
      e.stopPropagation();
      winDragging = true;
      document.body.style.cursor = cursorFor(edge);
      postToHost({ type: 'windowDrag', edge });
      return;
    }

    // 标题栏空白处按住 → 移动窗口（按钮上不触发，否则点"打开/关闭"会变成拖窗）
    const t = e.target as HTMLElement | null;
    if (t && t.closest('#chrome') && !t.closest('button')) {
      e.preventDefault();
      winDragging = true;
      postToHost({ type: 'windowDrag', edge: HT_CAPTION });
    }
  }, true);

  const endDrag = (): void => {
    if (!winDragging) return;
    winDragging = false;
    document.body.style.cursor = '';
    postToHost({ type: 'windowDragEnd' });
  };
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
  window.addEventListener('blur', endDrag);
}

// ---------- 预览控制 ----------
function renderCurrent(): void {
  if (sel < 0 || sel >= list.length) return;
  try {
    hostLog(`渲染预览：${list[sel].path}（${list[sel].category}）`);
    renderPreview(list[sel], body, bar);
  } catch (err: any) {
    hostError('渲染预览失败：' + (err?.stack || err?.message || String(err)));
    body.innerHTML = `<div class="pv-error">预览渲染失败：${err?.message || err}</div>`;
  }
  updateIndexHint();
  updateChrome();
}

// 底部栏追加 “当前 / 总数”（服务模式下用于提示翻页位置）
function updateIndexHint(): void {
  if (!serviceMode || list.length === 0) return;
  const hint = document.createElement('span');
  hint.className = 'pb-index';
  hint.textContent = `${sel + 1} / ${list.length}`;
  bar.appendChild(hint);
}

function openPreview(): void {
  if (list.length === 0) return;
  open = true;
  pane.dataset.open = 'true';
  renderCurrent();
}

function closePreview(): void {
  open = false;
  pane.dataset.open = 'false';
  // 大视频先把 src 摘掉再清空节点：直接 innerHTML='' 只是把元素从树上摘下来，
  // 未播完的分片请求可能仍在后台继续，密密麻麻的 Range 请求叠在关闭瞬间。
  // 显式 pause + removeAttribute('src') + load() 会让浏览器立即中止取流。
  body.querySelectorAll('video, audio').forEach((node) => {
    const m = node as HTMLMediaElement;
    try { m.pause(); m.removeAttribute('src'); m.load(); } catch { /* 忽略释放异常 */ }
  });
  // 丢弃仍在跑的渲染任务（PDF 逐页渲染不会自己停），并清空内容，
  // 避免下一次打开时先闪一下上一个文件的内容。
  cancelRender();
  body.innerHTML = '';
  bar.innerHTML = '';
  updateChrome();
}

function clamp(i: number): number {
  return Math.max(0, Math.min(list.length - 1, i));
}

function selectIndex(i: number): void {
  sel = clamp(i);
  updateActive();
}

function move(d: number): void {
  sel = clamp(sel + d);
  updateActive();
  if (!open) openPreview();
  else renderCurrent();
}

function moveSel(d: number): void {
  sel = clamp(sel + d);
  updateActive();
  if (open) renderCurrent();
}

// ---------- 宿主消息（C# → 渲染层） ----------
function itemFromPath(p: string): FileItem {
  const ext = extOf(p);
  const name = p.split(/[\\/]/).pop() || p;
  return { path: p, name, ext, category: categoryOfPath(p), size: 0 };
}

onHostMessage((msg: any) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'open') {
    // 宿主下发的 items 带 size 与 dir（文件夹没有扩展名，只能由宿主区分）；
    // 旧版本宿主没有该字段时回退到按 siblings 自行推断。
    // 切换目录/切换文件时先终止上一个渲染，防止旧内容继续翻页（串文件）
    cancelRender();
    body.innerHTML = '';
    bar.innerHTML = '';

    const raw: any[] = Array.isArray(msg.items) ? msg.items : [];
    if (raw.length) {
      // items 解析失败不能影响整个预览，失败就退回按路径自行推断
      try {
        list = raw.map((it: any) => {
          const p = String(it.path);
          return {
            path: p,
            name: String(it.name || p.split(/[\\/]/).pop() || p),
            ext: extOf(p),
            category: it.dir ? ('folder' as Category) : categoryOfPath(p),
            size: Number(it.size) || 0,
            isDir: !!it.dir
          } as FileItem;
        });
      } catch (e: any) {
        hostError('解析 items 失败，回退旧协议：' + (e?.message || e));
        list = [];
      }
    }
    if (!list.length) {
      const paths: string[] = Array.isArray(msg.siblings) ? msg.siblings : [];
      list = paths.length ? paths.map(itemFromPath) : [itemFromPath(String(msg.path))];
    }
    hostLog(`open 解析完成：items=${raw.length}，最终列表 ${list.length} 项`);

    const idx = list.findIndex((f) => f.path === msg.path);
    sel = idx >= 0 ? idx : 0;

    currentApp = typeof msg.currentApp === 'string' && msg.currentApp ? msg.currentApp : null;

    hostLog(`收到 open：${msg.path}（${list.length} 个可翻页项，索引 ${sel}）`);
    renderList();
    openPreview();
  } else if (msg.type === 'close') {
    closePreview();
  }
});

// 通知宿主：页面已就绪，可以下发 open 指令。
// 缺失这步时，程序刚启动后的第一次预览会在页面尚未初始化完成时就发出，指令被丢弃。
postToHost({ type: 'ready' });
hostLog('预览引擎已就绪（已注册宿主消息监听）');

// 分页器翻到首页/末页后**不再切换文件**。
//
// 曾经这里挂的是 `dir => move(dir)`，后果是：滚轮翻到最后一页后继续滚，
// 会直接跳到同目录的另一个文件（用户感觉是"随机跳"），而且往回滚也回不到原文件——
// 因为当前文件已经被换掉了，分页器也重置了。
// 现在滚轮与 PageUp/PageDown 只在文档内部翻页，翻到头就停住；
// 切换文件只由方向键触发（↑↓ 在任何视图都切文件，←→ 在翻到边界后切，对应平铺/网格布局）。
setPagerBoundaryHandler(null);

// ---------- 键盘 ----------
// 多页文档（PDF）里左右键先翻页，翻到首页/末页再翻才切换到上一个/下一个文件；
// 上下键始终是切换文件，两种操作互不打架。
window.addEventListener('keydown', (e) => {
  if (list.length === 0) return;
  const pager = currentPager();
  switch (e.code) {
    case 'Space':
      // 服务模式下空格由 C# 全局钩子处理并吞掉按键，此处不再重复处理
      if (serviceMode) return;
      e.preventDefault();
      open ? closePreview() : openPreview();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (!(pager && pager.next())) move(1);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (!(pager && pager.prev())) move(-1);
      break;
    case 'PageDown':
      // 只翻页，翻到底就停住，不切文件（切文件是方向键的职责）
      if (pager) { e.preventDefault(); pager.next(); }
      break;
    case 'PageUp':
      if (pager) { e.preventDefault(); pager.prev(); }
      break;
    case 'Home':
      if (pager) { e.preventDefault(); pager.goto(1); }
      break;
    case 'End':
      if (pager) { e.preventDefault(); pager.goto(pager.pageCount); }
      break;
    case 'ArrowDown':
      e.preventDefault(); moveSel(1); break;
    case 'ArrowUp':
      e.preventDefault(); moveSel(-1); break;
    case 'Escape':
      if (open) closePreview();
      if (serviceMode) postToHost({ type: 'requestClose' });
      break;
  }
});

// ---------- 按钮 ----------
$('btn-files').addEventListener('click', async () => {
  const res = await (window as any).qp?.openFiles?.();
  if (res && res.length) { list = res; sel = 0; renderList(); }
});
$('btn-folder').addEventListener('click', async () => {
  const res = await (window as any).qp?.openFolder?.();
  if (res && res.length) { list = res; sel = 0; renderList(); }
});

renderList();
