// 按文件类别渲染预览内容
//
// 重型解析库（pdf.js / mammoth / docx-preview / SheetJS / pptx）全部改为【按需动态加载】：
// 它们加起来超过 1MB，若全部打进首屏包，页面要解析完 1MB JS 才能上报 ready，
// 宿主在此之前下发的 open 指令只能排队，表现为"按空格后要等好几秒才有内容"。
// 拆包后首屏只剩几十 KB，页面几乎立刻就绪，各类型首次预览时再加载自己需要的库。
import { appLocalUrl, el } from './util';
import { isWebView2, QP, postToHost, requestFile, requestMedia, requestFolderStat } from './host';
import { renderPdfViewer, type Pager } from './pdfview';
import { readCsv, buildCsvView } from './csv';
import { renderTextViewer } from './text';
import { extractDocText, docTextToHtml } from './doc';
import type { FileItem } from '../../shared/types';

type Body = HTMLElement;
type Bar = HTMLElement;

function setBar(bar: Bar, item: FileItem, extra = ''): void {
  bar.innerHTML = '';
  const name = el('span', 'pb-name', item.name);
  const info = el('span', '', extra);
  bar.appendChild(name);
  bar.appendChild(info);
}

function showLoading(body: Body, text: string): void {
  body.innerHTML = '';
  body.appendChild(el('div', 'loading', text));
}

function showError(body: Body, msg: string): void {
  body.innerHTML = '';
  body.appendChild(el('div', 'error-box', msg));
}

function resetScroll(body: Body, scrollable: boolean): void {
  body.classList.toggle('scroll-mode', scrollable);
  body.scrollTop = 0;
}

/**
 * 读取本地文件内容。
 * 优先走宿主直传通道（window.QP.readFileAsync → base64），不经过 HTTP 拦截，
 * 因此不受虚拟主机映射影响；Electron 开发模式下回退到 local:// 协议。
 */
async function loadArrayBuffer(path: string): Promise<ArrayBuffer> {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // 主通道：__local 流式读取（支持任意大小，已验证可用）
  const res = await fetch(appLocalUrl(path));
  if (res.ok) {
    const ab = await res.arrayBuffer();
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    const name = path.replace(/\\/g, '/').split('/').pop() || path;
    postToHost({ type: 'log', message: `读取 ${name} ${ab.byteLength} 字节，耗时 ${ms} ms` });
    return ab;
  }

  // 回退通道：宿主直传 base64（不经 HTTP 拦截），用于 __local 被拦截/失效的场景
  postToHost({ type: 'log', message: '__local 返回 HTTP ' + res.status + '，回退宿主直传：' + path });
  try {
    const r = await requestFile(path);
    if (r && r.ok && typeof r.base64 === 'string') return base64ToArrayBuffer(r.base64);
    throw new Error((r && r.error) || '宿主直传失败');
  } catch (e: any) {
    throw new Error('读取文件失败：HTTP ' + res.status + '；直传也失败：' + (e?.message || e));
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  // .jfif 就是 JPEG，只是扩展名不同；给错的 mime 会让 <img> 直接拒绝解码
  jfif: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic'
};

/**
 * 渲染代次（generation）。
 * PDF 是「逐页顺序渲染」的循环，本身不会自己停下来；如果打开新文件时不去终止它，
 * 旧循环会继续往页面里追加画布、刷新页码，看起来就是"疯狂翻上一个 PDF / 串文件"。
 * 每次开始新渲染（或收到 close/open）都 ++renderGen，渲染过程中一旦发现代次变了就立刻放弃。
 */
let renderGen = 0;

/**
 * 当前预览的「分页器」（目前只有 PDF 有）。
 * 多页文档里左右方向键应当翻页而不是切换文件，由 main.ts 通过它判断。
 */
let _pager: Pager | null = null;
export function currentPager(): Pager | null {
  return _pager && _pager.pageCount > 1 ? _pager : null;
}

/** 分页器翻到头之后要切换文件：由 main.ts 注册处理函数（避免循环依赖） */
let _onBoundary: ((dir: number) => void) | null = null;
export function setPagerBoundaryHandler(fn: ((dir: number) => void) | null): void {
  _onBoundary = fn;
}

function dropPager(): void {
  if (!_pager) return;
  try { _pager.destroy(); } catch { /* 忽略销毁异常 */ }
  _pager = null;
}

/** 丢弃正在进行/排队中的渲染任务（切换文件、关闭预览时调用）。 */
export function cancelRender(): void {
  renderGen++;
  dropPager();
}

function stale(my: number): boolean {
  return my !== renderGen;
}

export async function renderPreview(item: FileItem, body: Body, bar: Bar): Promise<void> {
  const my = ++renderGen;
  dropPager();      // 上一个 PDF 的渲染循环必须先停掉，否则会继续画旧文档
  // 渲染结果上报宿主日志，便于排查「窗口弹出但内容空白/失败」
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  try {
    await renderCore(item, body, bar, my);
    if (stale(my)) return;                       // 已被更新的预览取代，静默放弃
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    postToHost({ type: 'log', message: `渲染完成：${item.name}（耗时 ${ms} ms）` });
  } catch (e: any) {
    if (stale(my)) return;
    const msg = '预览出错：' + (e?.message || String(e));
    showError(body, msg);
    postToHost({ type: 'error', message: msg + '（' + item.path + '）' });
  }
}

async function renderCore(item: FileItem, body: Body, bar: Bar, my: number): Promise<void> {
  setBar(bar, item, '');

  {
    if (item.category === 'image') {
      resetScroll(body, false);
      showLoading(body, '加载图片…');
      const ab = await loadArrayBuffer(item.path);
      if (stale(my)) return;
      const url = URL.createObjectURL(new Blob([ab], { type: IMAGE_MIME[item.ext] || '' }));
      const img = document.createElement('img');
      img.className = 'img-content';
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          body.innerHTML = '';
          body.appendChild(img);
          // 底部标注真实像素尺寸与文件大小（缩放显示时看不出原图多大）
          const bytes = item.size || ab.byteLength;
          setBar(bar, item, `${img.naturalWidth} × ${img.naturalHeight} px · ${humanSize(bytes)}`);
          resolve();
        };
        img.onerror = () => { showError(body, '图片加载失败'); reject(new Error('图片加载失败')); };
      });
      return;
    }

    if (item.category === 'text') {
      // 大文本（电子书类）必须分块：一次性解码+建 DOM 会直接卡死
      resetScroll(body, true);
      showLoading(body, '读取文本…');
      await renderTextViewer(item.path, body, bar, { stale: () => stale(my) });
      return;
    }

    if (item.category === 'folder') {
      resetScroll(body, true);
      await renderFolder(item, body, bar, my);
      return;
    }

    if (item.category === 'pdf') {
      // 单页横向翻页：不再把所有页纵向堆叠（堆叠 + CSS 强制宽度会把页面压扁）
      resetScroll(body, false);
      showLoading(body, '渲染 PDF…');
      const ab = await loadArrayBuffer(item.path);
      if (stale(my)) return;
      const pager = await renderPdfViewer(ab, body, bar, {
        name: item.name,
        stale: () => stale(my),
        // 滚轮/方向键翻到末尾再翻 → 切到相邻文件（与键盘行为保持一致）
        onBoundary: (dir) => { if (_onBoundary) _onBoundary(dir); }
      });
      if (stale(my)) { if (pager) pager.destroy(); return; }
      _pager = pager;
      return;
    }

    if (item.category === 'office') {
      resetScroll(body, true);
      await renderOffice(item, body, bar, my);
      return;
    }

    if (item.category === 'archive') {
      resetScroll(body, true);
      showLoading(body, '解析压缩包…');
      const { renderZipView, rangeZipSource, FULL_READ_MAX } = await import('./zip');
      if (stale(my)) return;

      // 大包绝不整包读进来：1.5GB 会是一个 200 全量响应，一次性塞进 WebView2
      // 会把浏览器进程打爆、连带宿主一起退出（用户看到的就是"预览压缩包闪退"）。
      // 超过阈值的包只按区间读中央目录，点开条目时再取单个文件的数据。
      let input: ArrayBuffer | import('./zip').ZipSource;
      if (item.size > FULL_READ_MAX) {
        postToHost({
          type: 'log',
          message: `压缩包较大（${item.size} 字节 > ${FULL_READ_MAX}），改为只读中央目录`
        });
        input = await rangeZipSource(item.path, item.size);
      } else {
        input = await loadArrayBuffer(item.path);
      }
      if (stale(my)) return;
      await renderZipView(input, item.name, body, bar, { stale: () => stale(my) });
      return;
    }

    if (item.category === 'webarchive') {
      // 单文件网页（.mhtml / .mht）：拆 MIME 分包 → 资源内联 → 沙箱 iframe 渲染
      resetScroll(body, false);
      showLoading(body, '解析单文件网页…');
      const ab = await loadArrayBuffer(item.path);
      if (stale(my)) return;
      const { renderMhtmlView } = await import('./mhtml');
      if (stale(my)) return;
      await renderMhtmlView(ab, item, body, bar, { stale: () => stale(my) });
      return;
    }

    if (item.category === 'audio' || item.category === 'video') {
      resetScroll(body, false);
      showLoading(body, '准备媒体…（ape/mkv 等首次预览会转码，请稍候）');
      // WebView2 走消息往返通道（宿主对象方法 prepareMediaAsync 会因 COM 封送报 0x80070057）；
      // Electron 开发模式没有宿主，直接用原文件地址，常见 mp3/mp4 可原生播放。
      const r: any = isWebView2
        ? await requestMedia(item.path)
        : { ok: true, url: appLocalUrl(item.path), mime: '' };
      if (stale(my)) return;
      if (!r || !r.ok) {
        showError(body, '媒体准备失败：' + (r?.error || '未知错误'));
        return;
      }
      body.innerHTML = '';
      const wrap = el('div', 'media-wrap');
      const isAudio = item.category === 'audio';

      // 自动播放：音视频打开即播。WebView2 默认是有声自动播放需要用户手势，
      // 宿主侧启动参数已加 --autoplay-policy=no-user-gesture-required 解除该限制。
      const media = isAudio ? document.createElement('audio') : document.createElement('video');
      media.controls = true;
      media.autoplay = true;
      media.preload = 'auto';
      media.src = r.url;

      if (isAudio) {
        wrap.insertBefore(el('div', 'media-poster', '🎵'), null);
      } else {
        (media as HTMLVideoElement).style.maxHeight = '82%';
      }
      wrap.appendChild(media);
      body.appendChild(wrap);
      setBar(bar, item, r.mime || '');

      // 元数据（分辨率 / 时长 / MIME / 大小）加载完后补到右下角
      let described = false;
      const describe = () => {
        if (described) return;
        described = true;
        const parts: string[] = [];
        if (!isAudio) {
          const v = media as HTMLVideoElement;
          if (v.videoWidth && v.videoHeight) parts.push(`${v.videoWidth} × ${v.videoHeight}`);
        }
        if (isFinite(media.duration) && media.duration > 0) parts.push(fmtDuration(media.duration));
        if (r.mime) parts.push(r.mime);
        if (item.size) parts.push(humanSize(item.size));
        if (parts.length) setBar(bar, item, parts.join(' · '));
      };
      media.addEventListener('loadedmetadata', describe);
      // 元数据拿不到时（个别容器），至少把 MIME 和大小显示出来
      media.addEventListener('error', () => {
        if (stale(my)) return;
        describe();
        if (media.error && media.error.code >= 3) {
          showError(body, '媒体解码失败：' + (media.error.message || '编码不受支持'));
        }
      });

      // 自动播放可能被浏览器策略拒绝（有声播放需要用户手势）。
      // 视频退一步用静音再试一次 —— Chromium 对静音自动播放总是放行，至少画面能动；
      // 音频不静音重试（静音等于没播），只记日志等用户点播放。
      const played = media.play();
      if (played && typeof played.catch === 'function') {
        played.catch((err: any) => {
          postToHost({
            type: 'log',
            message: `自动播放被拒绝：${item.name}（${err?.name || err}）`
          });
          if (isAudio) return;
          try {
            media.muted = true;
            const retry = media.play();
            if (retry && typeof retry.catch === 'function') retry.catch(() => { /* 静音也不行就等用户点 */ });
          } catch { /* 忽略 */ }
        });
      }
      return;
    }

    showError(body, '不支持的文件类型');
  }
}

function humanSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 秒 → 1:23 / 1:02:03 */
function fmtDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 文件夹预览：先立刻显示文件夹名 + "正在计算大小…"，
 * 拿到宿主统计结果后刷新为真实大小/文件数/子目录数/顶层内容。
 * 统计走消息往返通道（宿主后台线程执行，超时会截断），不会把页面卡住。
 */
async function renderFolder(item: FileItem, body: Body, bar: Bar, my: number): Promise<void> {
  body.innerHTML = '';
  const wrap = el('div', 'folder-view');

  const head = el('div', 'fv-head');
  head.appendChild(el('div', 'fv-icon', '📁'));
  const meta = el('div', 'fv-meta');
  meta.appendChild(el('div', 'fv-name', escapeHtml(item.name)));
  meta.appendChild(el('div', 'fv-path', escapeHtml(item.path)));
  head.appendChild(meta);

  const grid = el('div', 'fv-grid');
  const cell = (label: string, value: string) => {
    const c = el('div', 'fv-cell');
    c.appendChild(el('div', 'fv-k', label));
    c.appendChild(el('div', 'fv-v', value));
    return c;
  };
  const sizeCell = cell('总大小', '计算中…');
  const fileCell = cell('文件数', '—');
  const dirCell = cell('子文件夹', '—');
  const timeCell = cell('修改时间', '—');
  grid.appendChild(sizeCell);
  grid.appendChild(fileCell);
  grid.appendChild(dirCell);
  grid.appendChild(timeCell);

  const listBox = el('div', 'fv-list');
  wrap.appendChild(head);
  wrap.appendChild(grid);
  wrap.appendChild(listBox);
  body.appendChild(wrap);
  setBar(bar, item, '文件夹');

  let r: any = null;
  try {
    r = await requestFolderStat(item.path);
  } catch (e: any) {
    if (stale(my)) return;
    if (!isWebView2) { showError(body, '文件夹统计需要宿主支持（当前为开发模式）'); return; }
    throw e;
  }
  if (stale(my)) return;

  if (!r || !r.ok) {
    (sizeCell.querySelector('.fv-v') as HTMLElement).textContent = '统计失败';
    (sizeCell.querySelector('.fv-v') as HTMLElement).classList.add('fv-err');
    listBox.appendChild(el('div', 'fv-empty', '读取失败：' + (r?.error || '未知错误')));
    return;
  }

  const sizeText = humanSize(r.size || 0) + (r.truncated ? ' (部分)' : '');
  (sizeCell.querySelector('.fv-v') as HTMLElement).textContent = sizeText;
  (fileCell.querySelector('.fv-v') as HTMLElement).textContent = String(r.files ?? 0);
  (dirCell.querySelector('.fv-v') as HTMLElement).textContent = String(r.dirs ?? 0);
  (timeCell.querySelector('.fv-v') as HTMLElement).textContent = r.modified || '—';
  setBar(bar, item, r.truncated ? `文件夹 · 统计超时（${r.elapsedMs}ms）` : `文件夹 · ${r.elapsedMs}ms`);

  const entries: any[] = Array.isArray(r.entries) ? r.entries : [];
  if (!entries.length) {
    listBox.appendChild(el('div', 'fv-empty', '（空文件夹）'));
    return;
  }
  const tbl = document.createElement('table');
  tbl.className = 'fv-table';
  tbl.innerHTML =
    '<thead><tr><th>名称</th><th class="num">大小</th><th>修改时间</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const e of entries) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.innerHTML = (e.dir ? '📁 ' : '📄 ') + escapeHtml(e.name);
    const td2 = document.createElement('td');
    td2.className = 'num';
    td2.textContent = e.dir ? '—' : humanSize(e.size || 0);
    const td3 = document.createElement('td');
    td3.textContent = e.modified || '';
    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  listBox.appendChild(tbl);
}

/**
 * 旧版 .doc（OLE2 / Word 97-2003 二进制格式）预览。
 * 没有可用的 JS 库能直接渲染 .doc，这里自行解析 OLE2 提取正文，
 * 再按段落/表格重建版式显示（见 lib/doc.ts）。
 */
async function renderDoc(
  item: FileItem, ab: ArrayBuffer, body: Body, bar: Bar, my: number
): Promise<void> {
  const r = extractDocText(ab);
  if (stale(my)) return;
  body.innerHTML = '';
  const page = el('div', 'office-content doc-page');
  page.innerHTML = docTextToHtml(r.text);
  body.appendChild(page);
  setBar(bar, item, 'Word（.doc 旧版格式 · 文本版式）');
  postToHost({
    type: 'log',
    message: `.doc 解析完成：${item.name}（${r.text.length} 字符，复杂格式=${r.complex}，片段=${r.pieces}）`
  });
}

/**
 * Word 预览。
 * 主通道 docx-preview：直接按 OOXML 还原排版（字体/字号/颜色/对齐/缩进/表格/图片/分页），
 * 观感接近 Word 本身，并改造成单页/双页阅读器（见 docxview.ts）；
 * 失败时回退 mammoth（只保留语义结构）保证大不了也能看到文字。
 */
async function renderDocx(
  item: FileItem, ab: ArrayBuffer, body: Body, bar: Bar, my: number
): Promise<void> {
  showLoading(body, '解析文档…');
  try {
    const { renderDocxViewer } = await import('./docxview');
    if (stale(my)) return;
    const pager = await renderDocxViewer(ab, body, bar, {
      name: item.name,
      stale: () => stale(my),
      onBoundary: (dir) => { if (_onBoundary) _onBoundary(dir); }
    });
    if (stale(my)) { if (pager) pager.destroy(); return; }
    if (pager) _pager = pager;
    return;
  } catch (e: any) {
    if (stale(my)) return;
    postToHost({ type: 'log', message: 'docx 高保真渲染失败，回退纯文本：' + (e?.message || e) });
  }

  // 回退通道
  const mammoth: any = (await import('mammoth')).default;
  if (stale(my)) return;
  const res = await mammoth.convertToHtml({ arrayBuffer: ab });
  if (stale(my)) return;
  body.innerHTML = '';
  body.appendChild(el('div', 'office-content', res.value || '<p>（空文档）</p>'));
  setBar(bar, item, 'Word（简化排版）');
}

async function renderOffice(item: FileItem, body: Body, bar: Bar, my: number): Promise<void> {
  const ext = item.ext;
  showLoading(body, '解析文档…');
  const ab = await loadArrayBuffer(item.path);
  if (stale(my)) return;

  // 旧版二进制格式：.doc 可提取正文预览；.ppt 暂无可用的纯前端解析器
  if (ext === 'doc') { await renderDoc(item, ab, body, bar, my); return; }
  if (ext === 'ppt') { showError(body, '旧版 .ppt 格式无法预览，请在 PowerPoint 中另存为 .pptx 后重试。'); return; }

  if (ext === 'docx' || ext === 'docm') {
    await renderDocx(item, ab, body, bar, my);
    return;
  }

  // CSV 单独渲染：SheetJS 读 CSV 依赖固定的分隔符/编码猜测，中文 GBK 文件容易乱码，
  // 且它不会把首行当表头。这里用自研解析（自动识别编码与 , ; Tab | 分隔符）出表格。
  if (ext === 'csv' || ext === 'tsv') {
    const t = readCsv(ab);
    if (stale(my)) return;
    body.innerHTML = '';
    body.appendChild(buildCsvView(t));
    setBar(bar, item, `CSV · ${t.rows.length} 行 × ${t.rows.reduce((m, r) => Math.max(m, r.length), 0)} 列`);
    postToHost({
      type: 'log',
      message: `CSV 解析完成：${item.name}（${t.rows.length} 行，分隔符=${t.delimiterName}，编码=${t.encoding}）`
    });
    return;
  }

  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') {
    const XLSX = await import('xlsx');
    if (stale(my)) return;
    const wb = XLSX.read(ab, { type: 'array' });
    if (stale(my)) return;
    body.innerHTML = '';
    const container = el('div', 'office-content');
    const tabs = el('div', 'sheet-tabs');
    const wrap = el('div');
    const pages: HTMLElement[] = [];
    wb.SheetNames.forEach((name, idx) => {
      const tab = el('div', 'sheet-tab', name);
      if (idx === 0) tab.classList.add('active');
      const page = el('div');
      page.innerHTML = safeSheetHtml(XLSX, wb.Sheets[name], name);
      page.style.display = idx === 0 ? 'block' : 'none';
      pages.push(page);
      tab.onclick = () => {
        pages.forEach((p, j) => (p.style.display = j === idx ? 'block' : 'none'));
        Array.from(tabs.children).forEach((c, j) => c.classList.toggle('active', j === idx));
      };
      tabs.appendChild(tab);
      wrap.appendChild(page);
    });
    container.appendChild(tabs);
    container.appendChild(wrap);
    body.appendChild(container);
    setBar(bar, item, `Excel · ${wb.SheetNames.length} 个表`);
    return;
  }

  if (ext === 'pptx' || ext === 'pptm') {
    const { renderPptx } = await import('./pptx');
    if (stale(my)) return;
    // 按预览区宽度决定幻灯片渲染宽度。
    // 减掉的是 .office-content 的左右内边距（36*2）再留一点余量，
    // 否则 960px 宽的幻灯片加上内边距会顶出横向滚动条。
    const targetW = Math.max(560, Math.min(1000, (body.clientWidth || 960) - 88));
    // 传入 body 作为懒渲染的滚动观察根、stale 用于切换文件时立刻停下
    const slides = await renderPptx(ab, targetW, { root: body, stale: () => stale(my) });
    body.innerHTML = '';
    const container = el('div', 'office-content');
    container.appendChild(slides);
    body.appendChild(container);
    const n = slides.querySelectorAll('.slide').length;
    setBar(bar, item, `PPT · ${n} 页`);
    return;
  }

  showError(body, '不支持的办公文件类型：.' + ext);
}

/**
 * SheetJS 的 sheet_to_html 在遇到没有任何单元格的工作表时会抛
 * "Cannot read properties of undefined (reading 'indexOf')"（内部取 !ref 失败），
 * 一个空表就会让整个文件预览失败（用户实测的 xlsx 就是 Sheet3 为空表）。
 * 这里逐个表兜底：单表失败只显示提示，不影响其它表。
 */
function safeSheetHtml(XLSX: any, sheet: any, name: string): string {
  if (!sheet || !sheet['!ref']) return '<p class="sheet-empty">（工作表「' + escapeHtml(name) + '」没有内容）</p>';
  try {
    return XLSX.utils.sheet_to_html(sheet) || '<p class="sheet-empty">（空表）</p>';
  } catch (e: any) {
    postToHost({ type: 'log', message: '工作表 ' + name + ' 渲染失败，已跳过：' + (e?.message || e) });
    return '<p class="sheet-empty">（工作表「' + escapeHtml(name) + '」无法渲染）</p>';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
