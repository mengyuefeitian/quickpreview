// 旧版 .doc（OLE2 复合文档 / Word 97-2003 二进制格式）正文提取。
//
// 为什么自己写：
//   - mammoth / docx-preview 只认 OOXML(.docx)，对 .doc 直接报错；
//   - 试过的 word-extractor 对部分国产 Office（WPS 等）生成的 .doc 提取结果为空；
//   所以这里直接从 OLE2 容器里取 WordDocument 流，按 FIB 定位正文区间：
//     非快速保存（fComplex=0）→ 正文在 fcMin..fcMac 连续存放，直接截取；
//     快速保存（fComplex=1）  → 正文被切成碎片，需从 0Table/1Table 的 piece table 重组。
//
// 编码（8 位 ANSI / UTF-16LE）不迷信 FIB 的 fExtChar 标志位：实测部分文档该位与实际编码
// 不一致（WPS 生成的文档尤其常见），改为统计原始字节里 0x00 的比例来判断，更稳。

function rd16(a: Uint8Array, o: number): number {
  return a[o] | (a[o + 1] << 8);
}

function rd32(a: Uint8Array, o: number): number {
  return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;
}

const MAX_SECTOR = 0xfffffffa;

/** OLE2（CFB）复合文档读取器：只实现读取所需的 FAT / MiniFAT / 目录解析。 */
class Cfb {
  private b: Uint8Array;
  private ssz: number;
  private mssz: number;
  private fat: number[] = [];
  private miniFat: number[] = [];
  private mini: Uint8Array = new Uint8Array(0);
  private root: { start: number; size: number } = { start: 0, size: 0 };
  private entries = new Map<string, { start: number; size: number }>();

  constructor(buf: ArrayBuffer) {
    this.b = new Uint8Array(buf);
    this.ssz = 1 << rd16(this.b, 0x1e);
    this.mssz = 1 << rd16(this.b, 0x20);
    this.readFat();
    this.readDir();
  }

  private sector(n: number): Uint8Array {
    const off = (n + 1) * this.ssz;
    return this.b.subarray(off, Math.min(off + this.ssz, this.b.length));
  }

  private readFat(): void {
    const numFat = rd32(this.b, 0x2c);
    const difatStart = rd32(this.b, 0x44);

    // DIFAT 前 109 项内联在头部
    const difat: number[] = [];
    for (let i = 0; i < 109; i++) difat.push(rd32(this.b, 0x4c + i * 4));

    let ds = difatStart;
    let guard = 0;
    while (ds < MAX_SECTOR && guard++ < 4096) {
      const s = this.sector(ds);
      const n = Math.floor(this.ssz / 4) - 1;
      for (let i = 0; i < n; i++) difat.push(rd32(s, i * 4));
      ds = rd32(s, n * 4);
    }

    for (let i = 0; i < numFat && i < difat.length; i++) {
      const sn = difat[i];
      if (sn >= MAX_SECTOR) break;
      const s = this.sector(sn);
      for (let j = 0; j < Math.floor(this.ssz / 4); j++) this.fat.push(rd32(s, j * 4));
    }

    // MiniFAT
    const miniFatStart = rd32(this.b, 0x3c);
    const numMiniFat = rd32(this.b, 0x40);
    let ms = miniFatStart;
    guard = 0;
    while (ms < MAX_SECTOR && guard++ < numMiniFat + 16) {
      const s = this.sector(ms);
      for (let j = 0; j < Math.floor(this.ssz / 4); j++) this.miniFat.push(rd32(s, j * 4));
      ms = this.fat[ms] === undefined ? MAX_SECTOR : this.fat[ms];
    }
  }

  private chain(start: number, fat: number[]): number[] {
    const out: number[] = [];
    let c = start;
    let guard = 0;
    while (c < MAX_SECTOR && guard++ < 100000) {
      out.push(c);
      const nxt = fat[c];
      if (nxt === undefined) break;
      c = nxt;
    }
    return out;
  }

  private readStreamFat(start: number, size: number): Uint8Array {
    if (size <= 0 || start >= MAX_SECTOR) return new Uint8Array(0);
    const out = new Uint8Array(size);
    let written = 0;
    for (const s of this.chain(start, this.fat)) {
      const chunk = this.sector(s);
      const n = Math.min(chunk.length, size - written);
      out.set(chunk.subarray(0, n), written);
      written += n;
      if (written >= size) break;
    }
    return out.subarray(0, written);
  }

  private readDir(): void {
    const dirStart = rd32(this.b, 0x30);
    const cutoff = rd32(this.b, 0x38) || 4096;
    const dirBytes = this.readStreamFat(dirStart, Math.max(this.ssz, 1) * 8);

    for (let i = 0; i + 128 <= dirBytes.length; i += 128) {
      const e = dirBytes.subarray(i, i + 128);
      const type = e[0x42];
      const nameLen = rd16(e, 0x40);
      const start = rd32(e, 0x74);
      let size = rd32(e, 0x78);
      // 大文件用高 4 字节（此处忽略，Word 文档正文不会超过 4GB）
      if (type === 0) break;

      let name = '';
      for (let k = 0; k + 1 < Math.min(nameLen, 64); k += 2) {
        const code = rd16(e, k);
        if (code === 0) break;
        name += String.fromCharCode(code);
      }

      if (type === 5) {
        this.root = { start, size };
        if (start < MAX_SECTOR) {
          const chainBytes: number[] = [];
          let c = start, guard = 0;
          while (c < MAX_SECTOR && guard++ < 100000) {
            chainBytes.push(c);
            const nxt = this.fat[c];
            if (nxt === undefined) break;
            c = nxt;
          }
          this.mini = this.readStreamFat(start, chainBytes.length * this.ssz);
        }
      } else if (type === 2) {
        this.entries.set(name, { start, size });
      }
    }
    (this as any)._cutoff = cutoff;
  }

  private readMini(start: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let written = 0;
    let c = start;
    let guard = 0;
    while (c < MAX_SECTOR && written < size && guard++ < 100000) {
      const off = c * this.mssz;
      const chunk = this.mini.subarray(off, off + this.mssz);
      const n = Math.min(chunk.length, size - written);
      out.set(chunk.subarray(0, n), written);
      written += n;
      const nxt = this.miniFat[c];
      if (nxt === undefined) break;
      c = nxt;
    }
    return out.subarray(0, written);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  read(name: string): Uint8Array {
    const e = this.entries.get(name);
    if (!e) return new Uint8Array(0);
    const cutoff = (this as any)._cutoff || 4096;
    if (e.size < cutoff && this.mini.length) return this.readMini(e.start, e.size);
    return this.readStreamFat(e.start, e.size);
  }
}

/** 按编码解码字节；TextDecoder 不支持 GBK 时逐级回退。 */
function decodeAnsi(b: Uint8Array): string {
  const encodings = ['gbk', 'gb18030', 'windows-1252', 'latin1'];
  for (const enc of encodings) {
    try {
      return new TextDecoder(enc).decode(b);
    } catch { /* 继续尝试下一个 */ }
  }
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function decodeUtf16(b: Uint8Array): string {
  const n = b.length - (b.length % 2);
  let s = '';
  for (let i = 0; i < n; i += 2) s += String.fromCharCode(rd16(b, i));
  return s;
}

/**
 * 非快速保存文档的整体编码判断。
 * UTF-16LE 文本中只要出现 ASCII（空格/回车/数字/标点）就会有 0x00 字节，
 * 而 8 位 ANSI（GBK/CP1252）正文几乎不会出现 0x00，据此区分比读 FIB 标志位更可靠。
 */
function looksUtf16(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  let zeros = 0;
  const step = Math.max(1, Math.floor(b.length / 4096));
  let n = 0;
  for (let i = 0; i < b.length; i += step) {
    if (b[i] === 0) zeros++;
    n++;
  }
  return n > 0 && zeros / n > 0.02;
}

export interface DocText {
  text: string;      // 提取出的正文（含 \r 段落标记、\x07 单元格标记等原始控制符）
  pieces: number;    // piece 数（快速保存文档 > 1）
  complex: boolean;
}

/** 从 .doc 二进制内容提取正文。失败时抛异常，由调用方统一提示。 */
export function extractDocText(buf: ArrayBuffer): DocText {
  if (buf.byteLength < 512) throw new Error('文件太小，不是有效的 .doc 文档');
  const sig = new Uint8Array(buf, 0, 8);
  const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i++) {
    if (sig[i] !== OLE_SIG[i]) throw new Error('不是 OLE2 复合文档（可能不是 Word 97-2003 格式）');
  }

  const cfb = new Cfb(buf);
  const wd = cfb.read('WordDocument');
  if (wd.length < 0x200) throw new Error('WordDocument 流过短，文档可能已损坏');

  const flags = rd16(wd, 0x08);
  const fComplex = (flags & 0x0004) !== 0;
  const fWhichTblStm = (flags & 0x0200) !== 0;
  const fcMin = rd32(wd, 0x18);
  const fcMac = rd32(wd, 0x1c);

  if (!fComplex) {
    const start = Math.min(fcMin, wd.length);
    const end = Math.min(fcMac, wd.length);
    const raw = wd.subarray(start, Math.max(start, end));
    return {
      text: looksUtf16(raw) ? decodeUtf16(raw) : decodeAnsi(raw),
      pieces: 1,
      complex: false
    };
  }

  // 快速保存：正文散落在多个 piece 中，按 piece table 重组
  const tableName = fWhichTblStm ? '1Table' : '0Table';
  const tbl = cfb.has(tableName) ? cfb.read(tableName) : new Uint8Array(0);
  const fcClx = rd32(wd, 0x1a2);
  const lcbClx = rd32(wd, 0x1a6);

  if (!tbl.length || fcClx === 0 || lcbClx === 0 || fcClx + lcbClx > tbl.length) {
    // piece table 不可用，退化为连续区间（可能缺内容，但至少能显示开头）
    const raw = wd.subarray(Math.min(fcMin, wd.length), Math.min(fcMac, wd.length));
    return {
      text: looksUtf16(raw) ? decodeUtf16(raw) : decodeAnsi(raw),
      pieces: 1,
      complex: true
    };
  }

  const clx = tbl.subarray(fcClx, fcClx + lcbClx);

  // Clx = 若干 Prc（0x01） + 一个 Pcdt（0x02）
  let p = 0;
  let plc: Uint8Array | null = null;
  while (p + 1 < clx.length) {
    const t = clx[p];
    if (t === 0x01) {
      let cb = rd16(clx, p + 1);
      if (cb & 0x8000) cb = cb - 0x10000;   // 有符号
      p += 3 + cb;
      continue;
    }
    if (t === 0x02) {
      const lcb = rd32(clx, p + 1);
      const end = Math.min(p + 5 + lcb, clx.length);
      plc = clx.subarray(p + 5, end);
      break;
    }
    break;
  }

  if (!plc || plc.length < 12) {
    const raw = wd.subarray(Math.min(fcMin, wd.length), Math.min(fcMac, wd.length));
    return {
      text: looksUtf16(raw) ? decodeUtf16(raw) : decodeAnsi(raw),
      pieces: 1,
      complex: true
    };
  }

  // PlcPcd：n+1 个 CP（4 字节）+ n 个 Pcd（8 字节）
  const n = Math.floor((plc.length - 4) / 12);
  if (n <= 0) throw new Error('piece table 为空');

  const pcdBase = (n + 1) * 4;
  let text = '';
  for (let i = 0; i < n; i++) {
    const cch = rd32(plc, (i + 1) * 4) - rd32(plc, i * 4);
    if (cch <= 0) continue;
    const fc = rd32(plc, pcdBase + i * 8 + 2);
    const compressed = (fc & 0x40000000) !== 0;
    const fcv = fc & 0x3fffffff;
    if (compressed) {
      // 8 位：fc 存的是「字符偏移 * 2」
      const off = Math.floor(fcv / 2);
      if (off >= wd.length) continue;
      text += decodeAnsi(wd.subarray(off, Math.min(off + cch, wd.length)));
    } else {
      const off = fcv;
      if (off >= wd.length) continue;
      text += decodeUtf16(wd.subarray(off, Math.min(off + cch * 2, wd.length)));
    }
  }

  return { text, pieces: n, complex: true };
}

// ---------- 正文 → HTML ----------
// Word 二进制正文用控制符表达结构：
//   \r  段落结束    \x07 单元格标记（行尾会再跟一个 \x07 作为行结束标记）
//   \x0b 软换行     \x0c 分页符 / 表格结束    \x08 内嵌图片
//
// 【表格重建】这是 .doc 预览的关键：
//   旧实现按 \r 切"段落"，再在段落里按 \x07 切单元格。但 Word 的表格里
//   \r 只在"单元格内部换行"时才出现，行与行之间是没有 \r 的 ——
//   于是整张表格被当成一个超长段落（这个申请表有 97 个单元格），
//   列数超过阈值后只能退化成一列文字堆，内容和版式完全对不上。
//
//   正确做法是逐字符扫描：
//     · 遇到 \x07 → 结束当前单元格；
//     · 如果结束出来的单元格是空的、且下一个字符也是 \x07 / 换行 → 说明这是"行结束标记"；
//     · 表格模式下遇到 \r 且当前单元格为空 → 表格结束，回到正文模式。

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Block = { t: 'p'; text: string } | { t: 'rows'; rows: string[][] };

/** 把 Word 正文控制流解析成"段落 + 表格行"块序列。 */
function parseBlocks(raw: string): Block[] {
  const blocks: Block[] = [];
  const text = raw
    .replace(/\x08/g, '〔图片〕')
    .replace(/\x0b/g, '\n');

  const rows: string[][] = [];
  let row: string[] = [];
  let buf = '';
  let para = '';
  let mode: 'text' | 'table' = 'text';

  const flushRow = () => { if (row.length) { rows.push(row); row = []; } };
  const flushTable = () => {
    flushRow();
    if (rows.length) blocks.push({ t: 'rows', rows: rows.splice(0) });
  };
  const flushPara = () => {
    const v = para.replace(/[ \t]+$/g, '');
    if (v.trim()) blocks.push({ t: 'p', text: v });
    para = '';
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '\x07') {
      if (mode === 'text') {
        // 第一个单元格标记：之前累积的正文（para）就是表格第一格
        mode = 'table';
        row = [para];
        para = '';
        continue;
      }

      const cell = buf;
      buf = '';
      if (cell.trim() !== '') {
        row.push(cell);
        continue;
      }
      // 空单元格：后面紧跟的仍是 \x07（或到结尾）→ 这是"行结束标记"
      const next = text[i + 1];
      if (next === '\x07') { row.push(''); continue; }
      flushRow();
      continue;
    }

    if (c === '\r' || c === '\x0c') {
      if (mode === 'table') {
        if (!buf && row.length === 0) { flushTable(); mode = 'text'; }
        else buf += '\n';
      } else {
        flushPara();
      }
      continue;
    }

    if (mode === 'table') buf += c;
    else para += c;
  }

  if (mode === 'table') flushTable();
  flushPara();
  return blocks;
}

const MAX_TABLE_COLS = 24;

export function docTextToHtml(raw: string): string {
  const blocks = parseBlocks(raw);
  const html: string[] = [];
  let seenTable = false;
  let seenParagraph = false;

  for (const b of blocks) {
    if (b.t === 'p') {
      // 表格之前的第一段正文字号更大、居中——申请表/公文的标题都是这么排的
      if (!seenTable && !seenParagraph && b.text.length <= 60 && !/[。；]$/.test(b.text)) {
        html.push(`<p class="doc-title">${esc(b.text)}</p>`);
      } else {
        html.push(`<p>${esc(b.text).replace(/\n/g, '<br>')}</p>`);
      }
      seenParagraph = true;
      continue;
    }

    seenTable = true;
    // 列数：取最多的一行；末尾全空的列直接裁掉（行结束标记会多造出一个空列）
    let cols = Math.min(MAX_TABLE_COLS, b.rows.reduce((m, r) => Math.max(m, r.length), 0));
    while (cols > 1 && b.rows.every((r) => !(r[cols - 1] ?? '').trim())) cols--;
    let t = '<table class="doc-table">';
    for (const r of b.rows) {
      t += '<tr>';
      for (let i = 0; i < cols; i++) {
        // 先转义再插 <br>，否则 <br> 会被当成文本转义掉（页面上会直接显示 "<br>"）
        const cell = esc(r[i] ?? '').replace(/\n/g, '<br>');
        t += `<td>${cell}</td>`;
      }
      t += '</tr>';
    }
    t += '</table>';
    html.push(t);
  }

  return html.join('') || '<p>（文档没有可提取的文本内容）</p>';
}
