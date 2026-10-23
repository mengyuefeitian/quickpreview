// MHTML / MHT（单文件网页）解析与渲染
//
// .mhtml 是 MIME `multipart/related`：一个 HTML 文档 + 它引用的图片 / CSS，
// 全部塞进同一个文件，每个 part 用 quoted-printable 或 base64 编码。
// 把它当普通文本预览只会看到 MIME 头和 `=3D` 这类转义 —— 所以这里自己拆包：
//   ① 按 boundary 切开各个 part；
//   ② 解出第一个 text/html 作为主文档（按 charset 解码）；
//   ③ 其余 part 转成 data URI，把 HTML 里 `cid:` 与原始 URL 的引用替换掉；
//   ④ 交给 sandbox iframe 渲染，原页面的 CSS 不会污染预览界面。
//
// 只做"离线优先"的还原：HTML 里仍指向外网的资源保留不动，联网时会去加载，
// 离线时只是缺图 —— 这比把外链全部掐断更接近原页面。
import { el, formatBytes } from './util';
import type { FileItem } from '../../shared/types';

export interface MhtmlStats {
  parts: number;        // 拆出的 part 总数
  inlined: number;      // 成功替换成 data URI 的引用次数
  external: number;     // 仍指向外网的引用数（估算）
  encoding: string;     // 主文档 Content-Transfer-Encoding
  charset: string;      // 主文档字符集
  title: string;
}

interface Part {
  headers: Record<string, string>;
  bytes: Uint8Array;
}

// ---------- 字节 <-> 二进制字符串 ----------
// 不能用 TextDecoder('latin1')：WHATWG 里 latin1 别名指向 windows-1252，
// 会把 0x80~0x9F 映射成别的字符，字节值就变了。
function bytesToBinaryString(u8: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;   // 一次 32K，避免 apply 参数过多导致栈溢出
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return s;
}

function binaryStringToBytes(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

function bytesToBase64(u8: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = atob(clean);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** quoted-printable：`=XX` 是字节，`=` 后接换行是软换行（要丢掉）。 */
function quotedPrintableToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d /* = */) {
      const hi = s.charCodeAt(i + 1);
      const lo = s.charCodeAt(i + 2);
      const hex = (n: number): number => {
        if (n >= 48 && n <= 57) return n - 48;
        if (n >= 65 && n <= 70) return n - 55;
        if (n >= 97 && n <= 102) return n - 87;
        return -1;
      };
      const h = hex(hi), l = hex(lo);
      if (h >= 0 && l >= 0) { out.push((h << 4) | l); i += 2; continue; }
      if (hi === 0x0d && lo === 0x0a) { i += 2; continue; }
      if (hi === 0x0a) { i += 1; continue; }
    }
    out.push(c & 0xff);
  }
  return new Uint8Array(out);
}

/** 头字段解析：以空格/Tab 开头的行是上一行的续行（boundary 常被折成多行）。 */
function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last = '';
  for (const line of head.split(/\r?\n/)) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && last) { out[last] += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    last = line.slice(0, i).toLowerCase().trim();
    out[last] = line.slice(i + 1).trim();
  }
  return out;
}

function splitEntity(text: string): { headers: Record<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { headers: {}, body: text };
  return { headers: parseHeaders(text.slice(0, m.index)), body: text.slice(m.index + m[0].length) };
}

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([\w\-:.]+)/i.exec(contentType || '');
  let cs = (m ? m[1] : 'utf-8').toLowerCase();
  // 中文站点常见 gb2312/gb18030 标注，统一按 gbk 解（是它的超集）
  if (cs === 'gb2312' || cs === 'gb18030' || cs === 'cp936') cs = 'gbk';
  return cs;
}

function decodeText(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function decodeBody(headers: Record<string, string>, body: string): Uint8Array {
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase().trim();
  if (enc === 'base64') return base64ToBytes(body);
  if (enc === 'quoted-printable') return quotedPrintableToBytes(body);
  return binaryStringToBytes(body);
}

/** 拆包 + 内联资源替换，返回可直接塞进 iframe 的 HTML。 */
export function parseMhtml(buf: ArrayBuffer): { html: string; stats: MhtmlStats } {
  const raw = bytesToBinaryString(new Uint8Array(buf));
  const top = splitEntity(raw);
  const ctype = top.headers['content-type'] || '';
  const bm = /boundary\s*=\s*"?([^";]+)"?/i.exec(ctype);
  if (!bm) throw new Error('不是 MHTML 文件：缺少 MIME boundary');

  const delim = '--' + bm[1].trim();
  const segments = top.body.split(delim);
  // 第一段是第一个 boundary 之前的 preamble（常见于 `This is a multi-part
  // message in MIME format.`），它不是一个 part，直接丢掉。
  if (segments.length < 2) throw new Error('MHTML 文件里找不到 boundary 分隔线');
  segments.shift();

  const parts: Part[] = [];
  for (let seg of segments) {
    seg = seg.replace(/^\r?\n/, '');
    if (!seg.trim()) continue;
    if (seg.startsWith('--')) break;                       // 结束标记 --boundary--
    const e = splitEntity(seg);
    parts.push({ headers: e.headers, bytes: decodeBody(e.headers, e.body) });
  }
  if (!parts.length) throw new Error('MHTML 里没有解析出任何 part');

  // 主文档：第一个 text/html；没有就退化为第一个 text/*
  let main = parts.find((p) => /^text\/html/i.test(p.headers['content-type'] || ''));
  if (!main) main = parts.find((p) => /^text\//i.test(p.headers['content-type'] || ''));

  const mainType = main ? (main.headers['content-type'] || 'text/html') : 'text/html';
  const charset = charsetOf(mainType);
  let html = main ? decodeText(main.bytes, charset) : '';

  // 其余 part → data URI，建立 `cid:...` 与 Content-Location 两套索引
  const data = new Map<string, string>();
  for (const p of parts) {
    if (p === main) continue;
    const ct = (p.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const cid = (p.headers['content-id'] || '').replace(/^<|>$/g, '').trim();
    const loc = (p.headers['content-location'] || '').trim();
    if (!cid && !loc) continue;
    const uri = 'data:' + ct + ';base64,' + bytesToBase64(p.bytes);
    if (cid) data.set('cid:' + cid, uri);
    if (loc) data.set(loc, uri);
  }

  let inlined = 0;
  // ① cid: 引用（内联 CSS / 小图标常走这条路）
  html = html.replace(/cid:([^"'()\s<>]+)/g, (whole, id: string) => {
    const uri = data.get('cid:' + id);
    if (!uri) return whole;
    inlined++;
    return uri;
  });
  // ② 原始 URL 引用（Blink 保存的图片多为 Content-Location 绝对地址）
  for (const [key, uri] of data) {
    if (key.startsWith('cid:')) continue;
    if (html.indexOf(key) < 0) continue;
    html = html.split(key).join(uri);
    inlined++;
  }

  // 只统计「真正会去联网取」的资源位引用：`<a href>` 这类普通超链接不算，
  // 否则一个正文里全是外链的新闻页会被误判成"缺图"。
  const external = (
    html.match(/<(?:img|script|link|source|video|audio|iframe|embed)\b[^>]*\b(?:src|href)\s*=\s*["']?https?:/gi) || []
  ).length + (html.match(/url\(\s*["']?https?:\/\//gi) || []).length;
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  return {
    html,
    stats: {
      parts: parts.length,
      inlined,
      external,
      encoding: (main && main.headers['content-transfer-encoding']) || '7bit',
      charset,
      title: tm ? tm[1].trim().slice(0, 120) : ''
    }
  };
}

/**
 * 渲染单文件网页。
 * 用 srcdoc + sandbox：原页面的 CSS / JS 都在独立文档里跑，
 * 既不会把预览界面染成白底黑字，也不给脚本访问父页面的能力。
 */
export async function renderMhtmlView(
  ab: ArrayBuffer,
  item: FileItem,
  body: HTMLElement,
  bar: HTMLElement,
  opts: { stale: () => boolean }
): Promise<void> {
  const { html, stats } = parseMhtml(ab);
  if (opts.stale()) return;

  body.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.className = 'mhtml-frame';
  // allow-scripts 但不给 allow-same-origin：脚本能跑（部分页面依赖它渲染），
  // 但处于不透明源，读不到父页面，也碰不到宿主页面里的任何东西。
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = html;
  body.appendChild(frame);

  const bits = ['单文件网页', `${stats.parts} 个片段`, `${stats.inlined} 处内联资源`];
  if (stats.external) bits.push(`${stats.external} 处外链资源需联网`);
  bits.push(formatBytes(item.size || ab.byteLength));

  bar.innerHTML = '';
  bar.appendChild(el('span', 'pb-name', item.name));
  bar.appendChild(el('span', '', bits.join(' · ')));
}
