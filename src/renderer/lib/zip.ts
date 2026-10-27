// ZIP 压缩包预览
//
// 目标：不打开外部工具就能看清包里有什么，并直接看常见小文件的内容。
//   · 顶部：包名、压缩包大小、文件/目录数、解压后总大小
//   · 列表：路径、大小、压缩后大小、修改时间（带搜索过滤）
//   · 点击文件：文本（前 512KB）或图片直接在下方预览；其它格式给出提示
//
// 三种来源，统一渲染：
//   1. 常规小包 → JSZip 整包挂内存，读内容最省事；
//   2. 加密包 / JSZip 不认识的算法 → 整包已在内存，退化到直读中央目录（zipdir.ts），
//      只列清单；
//   3. 大包（>64MB）→ 绝不整包进内存：按区间只抓中央目录列清单（zipdir.ts），
//      点开某个文件时再按区间抓那一个条目的数据并解压。
//
// 【为什么必须有第 3 条】1.5GB 的包以前走 `fetch(整份)`，会是一个 200 全量响应，
// 1.5GB 一次性塞进 WebView2，浏览器进程被打爆、连带宿主退出 —— 用户看到的就是
// "预览压缩包直接闪退"。现在大包连一次全量读都不会发。
import { el, appLocalUrl } from './util';
import { postToHost } from './host';
import {
  readZipDirectory, methodLabel, methodReadable,
  readZipDirectoryByRange, extractEntryByRange,
  type ZipDirEntry, type RangeRead
} from './zipdir';

/** 内存里整包解析的上限。超过就走区间索引，只读中央目录。 */
export const FULL_READ_MAX = 64 * 1024 * 1024;
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

/** 清单模式下，说明某个文件为什么读不出内容。 */
function lockReasonOf(e: ZipDirEntry): string {
  if (e.encrypted) {
    return e.method === 99
      ? '该文件使用 AES 加密，需要密码才能解压'
      : '该文件已加密，需要密码才能解压';
  }
  return `该文件使用 ${methodLabel(e.method)} 压缩，暂不支持直接预览`;
}

export interface ZipEntry {
  path: string;
  size: number;
  compressed: number;
  date: Date | null;
  /** 内容是否读不出来（加密 / 算法不支持）。清单仍可显示。 */
  locked: boolean;
  /** 读不出来的原因，用于点击时提示。 */
  lockReason: string;
  offset: number;
  method: number;
}

/** 压缩包数据来源：小包走内存、大包走区间读取，上层渲染逻辑不区分。 */
export interface ZipSource {
  archiveSize: number;
  entries: ZipEntry[];
  dirs: Set<string>;
  /** 是否只读了索引（大包）—— 顶部要给用户一句说明 */
  indexOnly: boolean;
  /** 整包级别的提示（例如清单被截断） */
  notice: string;
  read(e: ZipEntry): Promise<ArrayBuffer>;
}

export interface ZipViewOptions {
  stale: () => boolean;
}

/** 把中央目录条目整理成「文件列表 + 目录集合」。很多工具不写目录条目，目录要按路径推导。 */
function normalize(dir: ZipDirEntry[], lockedOf: (e: ZipDirEntry) => boolean): {
  entries: ZipEntry[]; dirs: Set<string>;
} {
  const entries: ZipEntry[] = [];
  const dirs = new Set<string>();

  for (const e of dir) {
    if (e.dir) { dirs.add(e.path); continue; }
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const locked = lockedOf(e);
    entries.push({
      path: e.path,
      size: e.size,
      compressed: e.compressed,
      date: e.date,
      locked,
      lockReason: locked ? lockReasonOf(e) : '',
      offset: e.offset,
      method: e.method
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  return { entries, dirs };
}

/**
 * 小包：整包已在内存，用 JSZip 解析，能读内容。
 * JSZip 遇到加密条目/不认识的算法是「整个包一起抛错」，清单也列不出来，
 * 所以这里必须 try，失败后退化到直读中央目录。
 */
async function bufferSource(ab: ArrayBuffer, name: string): Promise<ZipSource> {
  let zip: any = null;
  let zipErr = '';
  try {
    const JSZipMod: any = await import('jszip');
    const JSZip = JSZipMod.default || JSZipMod;
    zip = await JSZip.loadAsync(ab);
  } catch (e: any) {
    zipErr = e?.message || String(e);
  }

  if (zip) {
    const raw: ZipDirEntry[] = [];
    zip.forEach((path: string, f: any) => {
      const meta: any = (f as any)._data || {};
      raw.push({
        path: f.dir ? path.replace(/\/+$/, '') : path,
        dir: !!f.dir,
        size: Number(meta.uncompressedSize) || 0,
        compressed: Number(meta.compressedSize) || 0,
        date: meta.date instanceof Date ? meta.date : null,
        // JSZip 已经解开整包，说明算法它认识、也没有加密
        method: 8,
        encrypted: false,
        offset: -1
      });
    });
    const { entries, dirs } = normalize(raw, () => false);
    return {
      archiveSize: ab.byteLength,
      entries,
      dirs,
      indexOnly: false,
      notice: '',
      read: async (e) => {
        const f = zip.file(e.path);
        if (!f) throw new Error('条目已失效');
        return await f.async('arraybuffer');
      }
    };
  }

  // ---- 退化：直读中央目录，至少把清单列出来 ----
  const dir = readZipDirectory(ab);   // 再失败就让它抛出去，由上层显示
  const { entries, dirs } = normalize(dir.entries, (e) => e.encrypted || !methodReadable(e.method));
  postToHost({
    type: 'log',
    message: `ZIP 无法用 JSZip 解析（${zipErr}），已改为直读中央目录列出清单：${name}（${entries.length} 个文件）`
  });
  return {
    archiveSize: ab.byteLength,
    entries,
    dirs,
    indexOnly: true,
    notice: '',
    read: async (e) => {
      throw new Error(e.locked ? e.lockReason : '该压缩包无法解压内容，请用压缩软件打开');
    }
  };
}

/**
 * 大包：只读中央目录，内容按区间取。
 * @param path 绝对路径（走宿主 __local 通道）
 * @param size 文件大小；宿主单次 206 响应上限 8MB，所以分片必须小于它
 */
export async function rangeZipSource(path: string, size: number): Promise<ZipSource> {
  const url = appLocalUrl(path);

  const read: RangeRead = async (start, end) => {
    // 用查询参数而不是 Range 请求头：请求头会触发 CORS 预检，
    // 宿主那边没有处理 OPTIONS，预检一失败整条路就废了。
    const res = await fetch(url + '&r=' + start + '-' + end);
    if (!res.ok) throw new Error('读取压缩包失败：HTTP ' + res.status);
    const ab = await res.arrayBuffer();
    const want = end - start + 1;
    if (ab.byteLength !== want) {
      throw new Error(`区间读取长度不符（期望 ${want}，实际 ${ab.byteLength} 字节）`);
    }
    return new Uint8Array(ab);
  };

  const t0 = Date.now();
  const dir = await readZipDirectoryByRange(size, read);
  const { entries, dirs } = normalize(dir.entries, (e) => e.encrypted || !methodReadable(e.method));

  postToHost({
    type: 'log',
    message: `ZIP 大包走区间索引：${entries.length} 个文件，${Date.now() - t0} ms（未整包读取）`
  });

  return {
    archiveSize: size,
    entries,
    dirs,
    indexOnly: true,
    notice: '📦 压缩包较大，已按需读取索引（未整包载入内存）；点开单个文件仍可直接预览。',
    read: (e) => extractEntryByRange(
      {
        path: e.path, dir: false, size: e.size, compressed: e.compressed,
        date: e.date, method: e.method, encrypted: false, offset: e.offset
      },
      read
    )
  };
}

export async function renderZipView(
  input: ArrayBuffer | ZipSource,
  name: string,
  body: HTMLElement,
  bar: HTMLElement,
  opts: ZipViewOptions
): Promise<void> {
  const src = input instanceof ArrayBuffer ? await bufferSource(input, name) : input;
  if (opts.stale()) return;

  const entries = src.entries;
  const dirCount = src.dirs.size;
  const totalSize = entries.reduce((n, e) => n + e.size, 0);
  const lockedCount = entries.reduce((n, e) => n + (e.locked ? 1 : 0), 0);

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
  meta.appendChild(el('span', 'zip-k', `压缩包 ${humanSize(src.archiveSize)}`));
  head.appendChild(meta);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'zip-search';
  search.placeholder = '筛选文件名…';
  head.appendChild(search);
  view.appendChild(head);

  // 清单模式提示：告诉用户为什么只能看名字、读不了内容
  if (lockedCount > 0) {
    const allEncrypted = lockedCount === entries.length
      && entries.every((e) => e.lockReason.indexOf('加密') >= 0);
    const notice = el('div', 'zip-notice');
    notice.textContent = allEncrypted
      ? `🔒 该压缩包已加密，需要密码才能解压 —— 以下仅列出文件清单（${entries.length} 个文件）`
      : `🔒 包内 ${lockedCount} 个文件无法解压预览 —— 以下仍列出完整清单`;
    view.appendChild(notice);
  }
  if (entries.length && src.notice) {
    view.appendChild(el('div', 'zip-notice', src.notice));
  }

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
      const mark = e.locked
        ? '🔒 '
        : (TEXT_EXT.has(icon) || IMAGE_EXT.has(icon) ? '📄 ' : '📦 ');
      tdName.textContent = mark + e.path;
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

  async function openEntry(e: ZipEntry, tr: HTMLElement): Promise<void> {
    Array.from(tbody.querySelectorAll('.zip-row')).forEach((r) => r.classList.remove('active'));
    tr.classList.add('active');

    panel.style.display = 'block';
    panel.innerHTML = '';
    const ext = extOfName(e.path);

    const mkHead = (): void => {
      const h = el('div', 'zip-pv-head');
      h.appendChild(el('span', '', e.path));
      h.appendChild(el('span', 'zip-pv-size', humanSize(e.size)));
      panel.appendChild(h);
    };

    // 清单模式：内容读不出来，直接说明原因，不要还显示"解压中…"吊着
    if (e.locked) {
      mkHead();
      const lb = el('div', 'zip-pv-body');
      lb.appendChild(el('div', 'zip-pv-tip', '🔒 ' + e.lockReason));
      lb.appendChild(el('div', 'zip-pv-tip', '请用压缩软件输入密码解压后再打开。'));
      panel.appendChild(lb);
      return;
    }

    mkHead();

    const box = el('div', 'zip-pv-body');
    panel.appendChild(box);
    box.appendChild(el('div', 'loading', '解压中…'));

    try {
      if (IMAGE_EXT.has(ext)) {
        const buf = await src.read(e);
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
        const buf = await src.read(e);
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
    message: `ZIP 解析完成：${name}（${entries.length} 个文件，${dirCount} 个目录，`
      + `解压后 ${humanSize(totalSize)}${src.indexOnly ? '，索引模式' : ''}）`
  });
}
