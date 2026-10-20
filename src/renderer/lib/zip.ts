// ZIP 压缩包预览
//
// 目标：不打开外部工具就能看清包里有什么，并直接看常见小文件的内容。
//   · 顶部：包名、压缩包大小、文件/目录数、解压后总大小
//   · 列表：路径、大小、压缩后大小、修改时间（带搜索过滤）
//   · 点击文件：文本（前 512KB）或图片直接在下方预览；其它格式给出提示
//
// 只读，不解压到磁盘。整个包用 JSZip 挂在内存里，几十 MB 的包能接受；
// 超大包（>512MB）直接拒绝解析，避免把内存打满。
import { el } from './util';
import { postToHost } from './host';

const MAX_ARCHIVE = 512 * 1024 * 1024;   // 超过这个大小不做解析
const MAX_INLINE_TEXT = 512 * 1024;      // 包内文本预览上限
const TEXT_EXT = new Set([
  'txt', 'md', 'mkd', 'markdown', 'json', 'log', 'yaml', 'yml', 'xml', 'ini',
  'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  'html', 'htm', 'sh', 'bat', 'ps1', 'sql', 'toml', 'env', 'csv', 'tsv', 'gitignore'
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  jfif: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif'
};

function humanSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function extOfName(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

interface Entry {
  path: string;
  dir: boolean;
  size: number;
  compressed: number;
  date: Date | null;
}

export interface ZipViewOptions {
  stale: () => boolean;
}

export async function renderZipView(
  ab: ArrayBuffer, name: string, body: HTMLElement, bar: HTMLElement, opts: ZipViewOptions
): Promise<void> {
  if (ab.byteLength > MAX_ARCHIVE) {
    throw new Error(`压缩包过大（${humanSize(ab.byteLength)}），超过 ${humanSize(MAX_ARCHIVE)} 上限，暂不支持预览`);
  }

  // 动态加载 JSZip：它约 100KB，只有真正打开压缩包时才需要，
  // 静态 import 会把它塞进首屏包并拖慢页面 ready。
  const JSZipMod: any = await import('jszip');
  const JSZip = JSZipMod.default || JSZipMod;
  const zip = await JSZip.loadAsync(ab);
  if (opts.stale()) return;

  const entries: Entry[] = [];
  let totalSize = 0;
  // 很多压缩工具不写"目录条目"（只有文件），目录数要按路径推导，否则一律显示 0
  const dirs = new Set<string>();
  zip.forEach((path: string, f: any) => {
    const meta: any = (f as any)._data || {};
    if (f.dir) return;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const size = Number(meta.uncompressedSize) || 0;
    const compressed = Number(meta.compressedSize) || 0;
    totalSize += size;
    entries.push({
      path,
      dir: false,
      size,
      compressed,
      date: meta.date instanceof Date ? meta.date : null
    });
  });
  const dirCount = dirs.size;
  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  if (opts.stale()) return;

  body.innerHTML = '';
  const view = el('div', 'zip-view');

  // ---------- 顶部信息 ----------
  const head = el('div', 'zip-head');
  const title = el('div', 'zip-title');
  title.appendChild(el('span', 'zip-icon', '🗜'));
  title.appendChild(el('span', 'zip-name', name));
  head.appendChild(title);
  const meta = el('div', 'zip-meta');
  meta.appendChild(el('span', 'zip-k', `${entries.length} 个文件`));
  meta.appendChild(el('span', 'zip-k', dirCount ? `${dirCount} 个目录` : '无子目录'));
  meta.appendChild(el('span', 'zip-k', `解压后 ${humanSize(totalSize)}`));
  meta.appendChild(el('span', 'zip-k', `压缩包 ${humanSize(ab.byteLength)}`));
  head.appendChild(meta);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'zip-search';
  search.placeholder = '筛选文件名…';
  head.appendChild(search);
  view.appendChild(head);

  // ---------- 文件列表 ----------
  const listBox = el('div', 'zip-list');
  const tbl = document.createElement('table');
  tbl.className = 'zip-table';
  tbl.innerHTML =
    '<thead><tr><th>路径</th><th class="num">大小</th><th class="num">压缩后</th><th>修改时间</th></tr></thead>';
  const tbody = document.createElement('tbody');
  tbl.appendChild(tbody);
  listBox.appendChild(tbl);
  view.appendChild(listBox);

  // ---------- 包内预览面板 ----------
  const panel = el('div', 'zip-preview');
  panel.style.display = 'none';
  view.appendChild(panel);

  body.appendChild(view);
  bar.innerHTML = '';
  bar.appendChild(el('span', 'pb-name', name));
  bar.appendChild(el('span', '', `ZIP · ${entries.length} 个文件 · 解压后 ${humanSize(totalSize)}`));

  const dt = (d: Date | null): string => {
    if (!d) return '';
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function draw(keyword: string): void {
    const kw = keyword.trim().toLowerCase();
    const shown = kw ? entries.filter((e) => e.path.toLowerCase().includes(kw)) : entries;
    tbody.innerHTML = '';
    if (!shown.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'zip-empty';
      td.textContent = entries.length ? '（没有匹配的文件）' : '（空压缩包）';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    // 大包（几千文件）一次性建 DOM 也会卡，这里最多渲染 2000 行并给出提示
    const LIMIT = 2000;
    for (const e of shown.slice(0, LIMIT)) {
      const tr = document.createElement('tr');
      tr.className = 'zip-row';
      const tdName = document.createElement('td');
      const icon = extOfName(e.path);
      tdName.textContent = (TEXT_EXT.has(icon) || IMAGE_EXT.has(icon) ? '📄 ' : '📦 ') + e.path;
      tdName.title = e.path;
      const tdSize = document.createElement('td');
      tdSize.className = 'num';
      tdSize.textContent = humanSize(e.size);
      const tdC = document.createElement('td');
      tdC.className = 'num';
      tdC.textContent = e.compressed ? humanSize(e.compressed) : '—';
      const tdD = document.createElement('td');
      tdD.textContent = dt(e.date);
      tr.appendChild(tdName); tr.appendChild(tdSize); tr.appendChild(tdC); tr.appendChild(tdD);
      tr.addEventListener('click', () => { void openEntry(e, tr); });
      tbody.appendChild(tr);
    }
    if (shown.length > LIMIT) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'zip-empty';
      td.textContent = `（仅显示前 ${LIMIT} 项，共 ${shown.length} 项，请用筛选缩小范围）`;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  async function openEntry(e: Entry, tr: HTMLElement): Promise<void> {
    Array.from(tbody.querySelectorAll('.zip-row')).forEach((r) => r.classList.remove('active'));
    tr.classList.add('active');

    panel.style.display = 'block';
    panel.innerHTML = '';
    const ext = extOfName(e.path);
    const head2 = el('div', 'zip-pv-head');
    head2.appendChild(el('span', '', e.path));
    head2.appendChild(el('span', 'zip-pv-size', humanSize(e.size)));
    panel.appendChild(head2);

    const box = el('div', 'zip-pv-body');
    panel.appendChild(box);
    box.appendChild(el('div', 'loading', '解压中…'));

    try {
      const f = zip.file(e.path);
      if (!f) throw new Error('条目已失效');

      if (IMAGE_EXT.has(ext)) {
        const buf = await f.async('arraybuffer');
        if (opts.stale()) return;
        const url = URL.createObjectURL(new Blob([buf], { type: IMAGE_MIME[ext] || '' }));
        box.innerHTML = '';
        const img = document.createElement('img');
        img.className = 'zip-pv-img';
        img.src = url;
        box.appendChild(img);
        return;
      }

      if (TEXT_EXT.has(ext) || !ext) {
        const buf = await f.async('arraybuffer');
        if (opts.stale()) return;
        const slice = buf.byteLength > MAX_INLINE_TEXT ? buf.slice(0, MAX_INLINE_TEXT) : buf;
        const text = new TextDecoder('utf-8').decode(new Uint8Array(slice));
        box.innerHTML = '';
        const pre = el('pre', 'zip-pv-text');
        pre.textContent = text;
        box.appendChild(pre);
        if (buf.byteLength > MAX_INLINE_TEXT) {
          box.appendChild(el('div', 'zip-pv-tip',
            `文件较大，仅预览前 ${humanSize(MAX_INLINE_TEXT)}（共 ${humanSize(buf.byteLength)}）`));
        }
        return;
      }

      box.innerHTML = '';
      box.appendChild(el('div', 'zip-pv-tip',
        `「.${ext}」暂不支持在压缩包内直接预览，请解压后用默认程序打开。`));
    } catch (err: any) {
      box.innerHTML = '';
      box.appendChild(el('div', 'zip-pv-tip', '预览失败：' + (err?.message || err)));
    }
  }

  search.addEventListener('input', () => draw(search.value));
  draw('');

  postToHost({
    type: 'log',
    message: `ZIP 解析完成：${name}（${entries.length} 个文件，${dirCount} 个目录，解压后 ${humanSize(totalSize)}）`
  });
}
