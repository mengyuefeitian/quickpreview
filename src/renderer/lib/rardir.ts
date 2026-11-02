// RAR 压缩包结构直读（只读，不解压、不需要密码）
//
// 为什么不能像 ZIP 那样复用现成方案：
//   · RAR **没有**尾部中央目录。ZIP 能从文件尾一跳命中索引，RAR 只能从头把块头一个个走过去
//     （块头里有 dataSize，数据区可以整块跳过，所以不用把内容读进来）；
//   · RAR 的压缩算法是专有格式，浏览器里没有解压器（DecompressionStream 只有 deflate/gzip）。
//     所以这里只做两件事：列出清单；对 method=0（存储，即打包时没压缩）的条目直接读原始字节。
//
// 覆盖 RAR5（WinRAR 5 起，签名 Rar!\x1a\x07\x01\x00）与 RAR4（老格式，签名 ...\x07\x00）。
//
// 【RAR5 变长整数不是 LEB128】首字节 bit7 置位时，低 7 位表示「后面还有几个字节」，
// 后续字节按**大端**拼接。按 LEB128 解会得到完全离谱的偏移，之后一路错位。
//
// 【块长的算法】HEAD_SIZE 从「HEAD_TYPE 字段」起算，到 extra area 结束；数据区在它之后，
// 长度另由 DATA_SIZE 给出。所以 dataStart = headTypePos + headSize，
// 块尾 = dataStart + dataSize。用 HEAD_SIZE 当整块长度会漏掉 CRC 与自身两个字段的字节数。

export interface RarEntry {
  path: string;
  dir: boolean;
  /** 解压后大小 */
  size: number;
  /** 包内实际占用（压缩后大小） */
  compressed: number;
  date: Date | null;
  /** 0 = 存储（未压缩，可直接读）；其余为 RAR 专有算法 */
  method: number;
  encrypted: boolean;
  /** 数据区在包内的绝对偏移；读内容时用 */
  dataOffset: number;
}

export interface RarDir {
  format: 'rar5' | 'rar4';
  entries: RarEntry[];
  /** 包头被加密（rar -hp）：文件名也读不到，只能给出提示 */
  encryptedHeaders: boolean;
  /** 条目/块数超过上限，清单不完整 */
  truncated: boolean;
}

export type RangeRead = (start: number, end: number) => Promise<Uint8Array>;

const SIG5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const SIG4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];

/** 单次预读窗口。块头只有几十字节，但下一个块头往往紧邻，一次多拿点能少发几十个请求。 */
const WINDOW = 256 * 1024;
/** 遍历上限：防止损坏文件把解析器拖死（每块都要一次区间读）。 */
const MAX_BLOCKS = 200000;
const MAX_ENTRIES = 50000;
/** 单个条目允许读出来的上限，超过只提示。 */
export const RAR_ENTRY_READ_MAX = 64 * 1024 * 1024;

/** RAR4 文件头标志 */
const LHD_LARGE = 0x0100;
const LHD_PASSWORD = 0x0004;
const LHD_LONG_BLOCK = 0x8000;
/** RAR4 文件头的 type 与「存储」方法号 */
const HEAD_FILE4 = 0x74;
const HEAD_ENDARC4 = 0x7b;
const METHOD4_STORE = 0x30;

/** RAR5 文件头标志 */
const FH_DIRECTORY = 0x0001;
const FH_MTIME = 0x0002;
const FH_CRC32 = 0x0004;
/** Windows 文件属性里的目录位（ATTRIB 字段） */
const ATTR_DIRECTORY = 0x10;
/** RAR5 块级标志 */
const HF_EXTRA = 0x0001;
const HF_DATA = 0x0002;
const HT_FILE = 0x02;
const HT_ENCRYPTION = 0x04;
const HT_END = 0x05;
/** extra area 里的加密记录 */
const FHEXTRA_CRYPT = 0x01;

export const RAR_METHOD_LABEL: Record<number, string> = {
  0: '存储（未压缩）',
  1: 'RAR 最快压缩',
  2: 'RAR 较快压缩',
  3: 'RAR 标准压缩',
  4: 'RAR 较好压缩',
  5: 'RAR 最优压缩'
};

export function rarMethodLabel(m: number): string {
  return RAR_METHOD_LABEL[m] || ('RAR 算法 ' + m);
}

/** 只有存储方式能直接读出内容。 */
export function rarMethodReadable(m: number): boolean {
  return m === 0;
}

/** 带窗口缓存的分块读取器：解析器可以逐字节取，真正发出的请求数由窗口决定。 */
class Reader {
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private base = -1;

  constructor(private read: RangeRead, private total: number) {}

  async at(pos: number, len: number): Promise<Uint8Array> {
    if (len < 0 || pos < 0 || pos + len > this.total) throw new Error('RAR 结构越界（文件可能已损坏）');
    if (this.base >= 0 && pos >= this.base && pos + len <= this.base + this.buf.length) {
      const off = pos - this.base;
      return this.buf.subarray(off, off + len);
    }
    const want = Math.max(len, Math.min(WINDOW, this.total - pos));
    const end = Math.min(this.total - 1, pos + want - 1);
    const data = await this.read(pos, end);
    this.buf = data;
    this.base = pos;
    if (data.length < len) throw new Error('RAR 读取长度不足');
    return data.subarray(0, len);
  }
}

/** 小端游标（RAR4 全是固定宽度小端字段）。 */
class Cursor {
  pos: number;

  constructor(readonly r: Reader, pos: number) {
    this.pos = pos;
  }

  async u8(): Promise<number> {
    const b = await this.r.at(this.pos, 1);
    this.pos += 1;
    return b[0];
  }

  async u16(): Promise<number> {
    const b = await this.r.at(this.pos, 2);
    this.pos += 2;
    return b[0] | (b[1] << 8);
  }

  async u32(): Promise<number> {
    const b = await this.r.at(this.pos, 4);
    this.pos += 4;
    return (b[0] | (b[1] << 8) | (b[2] << 16)) + b[3] * 0x1000000;
  }

  /** RAR5 vint：LEB128 —— 低 7 位是数据、bit7 表示还有后续字节，低位在前。 */
  async vint(): Promise<number> {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      const b = await this.u8();
      v += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(v)) throw new Error('RAR5 变长整数超出安全范围');
        return v;
      }
      shift += 7;
    }
    throw new Error('RAR5 变长整数过长');
  }

  async bytes(n: number): Promise<Uint8Array> {
    const b = await this.r.at(this.pos, n);
    this.pos += n;
    return b;
  }
}

/** DOS 时间（RAR4 的 FTIME）→ Date。低 16 位时间、高 16 位日期。 */
function dosTime(v: number): Date | null {
  const t = v & 0xffff;
  const d = (v >>> 16) & 0xffff;
  if (!d) return null;
  const year = ((d >> 9) & 0x7f) + 1980;
  const month = (d >> 5) & 0x0f;
  const day = d & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day, (t >> 11) & 0x1f, (t >> 5) & 0x3f, (t & 0x1f) * 2);
}

/**
 * RAR 文件名解码。
 * RAR5 规范要求 UTF-8；RAR4 是本地 ANSI 代码页（中文系统为 GBK）。
 * 顺序仍是「先 UTF-8 严格、再 GBK」，理由与 zipdir.decodeName 相同：
 * GBK 几乎能解出任意字节且不报错，反过来会把 UTF-8 名字解成乱码还发现不了。
 */
function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* 继续试 GBK */ }
  try {
    const s = new TextDecoder('gbk').decode(bytes);
    if (s && !s.includes('\uFFFD')) return s;
  } catch { /* 环境不支持 gbk */ }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** RAR4 带 unicode 名字时，名字区是「ANSI 名 \0 unicode 编码」，清单用途取前半段即可。 */
function ansiNamePart(bytes: Uint8Array): Uint8Array {
  const zero = bytes.indexOf(0);
  return zero >= 0 ? bytes.subarray(0, zero) : bytes;
}

function normalizePath(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 读 RAR5 的 extra area，只为找加密记录。fieldSize 从 type 字段起算。 */
async function hasCryptRecord(c: Cursor, extraEnd: number): Promise<boolean> {
  let encrypted = false;
  let p = c.pos;
  let guard = 0;
  while (p < extraEnd && guard++ < 64) {
    const ec = new Cursor(c.r, p);
    const fieldSize = await ec.vint();
    if (fieldSize <= 0) break;
    const typePos = ec.pos;
    const fieldType = await ec.vint();
    if (fieldType === FHEXTRA_CRYPT) encrypted = true;
    const next = typePos + fieldSize; // fieldSize 含 type 字段本身
    if (next <= p) break;
    p = next;
  }
  return encrypted;
}

async function parseRar5(r: Reader, total: number, dir: RarDir): Promise<void> {
  let pos = 8;
  let blocks = 0;

  while (pos + 8 <= total) {
    if (++blocks > MAX_BLOCKS || dir.entries.length >= MAX_ENTRIES) {
      dir.truncated = true;
      return;
    }

    const c = new Cursor(r, pos);
    await c.u32();                                   // HEAD_CRC（固定 4 字节，不是 vint）
    const headSize = await c.vint();
    const headTypePos = c.pos;
    const headType = await c.vint();
    const headFlags = await c.vint();
    if (headFlags & HF_EXTRA) await c.vint();        // EXTRA_AREA_SIZE
    let dataSize = 0;
    if (headFlags & HF_DATA) dataSize = await c.vint();

    const dataStart = headTypePos + headSize;
    if (headSize <= 0 || dataStart > total || dataSize < 0) return;   // 结构损坏，保住已解析的部分
    const next = dataStart + dataSize;

    if (headType === HT_END) return;
    if (headType === HT_ENCRYPTION) {
      // 包头加密（rar -hp）：文件名与后续块头都不可读
      dir.encryptedHeaders = true;
      return;
    }
    if (headType !== HT_FILE) {
      pos = next > pos ? next : pos + 4;
      continue;
    }

    const fileFlags = await c.vint();
    const unpSize = await c.vint();
    const attrib = await c.vint();
    let date: Date | null = null;
    if (fileFlags & FH_MTIME) date = new Date((await c.u32()) * 1000);
    if (fileFlags & FH_CRC32) await c.u32();         // 数据 CRC
    const compInfo = await c.vint();
    await c.vint();                                  // HOST_OS
    const nameSize = await c.vint();
    if (c.pos + nameSize > dataStart) { pos = next > pos ? next : pos + 4; continue; }
    const nameBytes = await c.bytes(nameSize);

    const method = (compInfo >> 7) & 7;
    if (c.pos > dataStart) { pos = next > pos ? next : pos + 4; continue; }   // 头字段越界，跳过
    const encrypted = await hasCryptRecord(c, dataStart);

    const rawName = decodeName(nameBytes);
    const path = normalizePath(rawName);
    if (path) {
      dir.entries.push({
        path,
        // 目录判定要看三处：RAR5 的 FILE_FLAGS 目录位、Windows 的 ATTR_DIRECTORY、
        // 以及名字尾随分隔符 —— 有的打包工具只写其中一处（实测 WinRAR 只写 ATTR）。
        dir: (fileFlags & FH_DIRECTORY) !== 0 || (attrib & ATTR_DIRECTORY) !== 0 || /[\\/]$/.test(rawName),
        size: unpSize,
        compressed: dataSize,
        date,
        method,
        encrypted,
        dataOffset: dataStart
      });
    }
    pos = next > pos ? next : pos + 4;
  }
}

async function parseRar4(r: Reader, total: number, dir: RarDir): Promise<void> {
  let pos = 7;
  let blocks = 0;

  while (pos + 7 <= total) {
    if (++blocks > MAX_BLOCKS || dir.entries.length >= MAX_ENTRIES) {
      dir.truncated = true;
      return;
    }

    const c = new Cursor(r, pos);
    await c.u16();                                   // HEAD_CRC
    const headType = await c.u8();
    const headFlags = await c.u16();
    const headSize = await c.u16();
    let addSize = 0;
    if (headFlags & LHD_LONG_BLOCK) addSize = await c.u32();

    if (headSize < 7) return;
    const dataStart = pos + headSize;
    if (dataStart > total) return;
    const next = dataStart + addSize;

    if (headType === HEAD_ENDARC4) return;
    if (headType !== HEAD_FILE4) {
      pos = next > pos ? next : pos + 7;
      continue;
    }
    const packSize = await c.u32();
    let unpSize = await c.u32();
    await c.u8();                                    // HOST_OS
    await c.u32();                                   // FILE_CRC
    const ftime = await c.u32();
    await c.u8();                                    // UNP_VER
    const method = await c.u8();
    const nameSize = await c.u16();
    const attr = await c.u32();
    let compressed = packSize;
    if (headFlags & LHD_LARGE) {
      const highPack = await c.u32();
      const highUnp = await c.u32();
      compressed = highPack * 0x100000000 + packSize;
      unpSize = highUnp * 0x100000000 + unpSize;
    }
    // 有 LONG_BLOCK 时数据长度取 ADD_SIZE；没写这一位（少数工具）就得按 PACK_SIZE 跳过，
    // 否则数据区会被当成下一个块头，后面的条目全部丢掉。
    const dataLen = addSize > 0 ? addSize : compressed;
    const afterData = dataStart + dataLen;
    const fallback = next > pos ? next : pos + 7;
    if (c.pos + nameSize > dataStart) { pos = fallback; continue; }
    const nameBytes = await c.bytes(nameSize);

    const rawName = decodeName(ansiNamePart(nameBytes));
    const path = normalizePath(rawName);
    if (path) {
      dir.entries.push({
        path,
        dir: /[\\/]$/.test(rawName) || (attr & ATTR_DIRECTORY) !== 0,
        size: unpSize,
        compressed,
        date: dosTime(ftime),
        method: method === METHOD4_STORE ? 0 : (method & 0x0f),
        encrypted: (headFlags & LHD_PASSWORD) !== 0,
        dataOffset: dataStart
      });
    }
    pos = afterData > pos ? afterData : fallback;
  }
}

/** 判断文件头是不是 RAR（不依赖扩展名：改过名的包也能认出来）。 */
export function isRarSignature(head: Uint8Array): boolean {
  if (head.length >= 8 && SIG5.every((v, i) => head[i] === v)) return true;
  if (head.length >= 7 && SIG4.every((v, i) => head[i] === v)) return true;
  return false;
}

async function parseRar(r: Reader, total: number): Promise<RarDir> {
  const head = await r.at(0, Math.min(8, total));
  const dir: RarDir = { format: 'rar5', entries: [], encryptedHeaders: false, truncated: false };

  if (head.length >= 8 && SIG5.every((v, i) => head[i] === v)) {
    dir.format = 'rar5';
    await parseRar5(r, total, dir);
  } else if (head.length >= 7 && SIG4.every((v, i) => head[i] === v)) {
    dir.format = 'rar4';
    await parseRar4(r, total, dir);
  } else {
    throw new Error('不是有效的 RAR 文件（签名不匹配）');
  }

  // 目录条目排在前面，文件按路径排；与 ZIP 列表保持一致的观感
  dir.entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  return dir;
}

/** 内存版：整个包已经在 ArrayBuffer 里。 */
export function readRarDirectory(buf: ArrayBuffer): Promise<RarDir> {
  const bytes = new Uint8Array(buf);
  const read: RangeRead = async (start, end) => bytes.subarray(start, end + 1);
  return parseRar(new Reader(read, bytes.length), bytes.length);
}

/**
 * 区间版：大包绝不整包读。
 * 这里能省的关键是「块头里带着 dataSize」—— 数据区整块跳过，
 * 所以 1GB 的包也只读到块头（每次请求 256KB 窗口，多个块可命中同一窗口）。
 */
export function readRarDirectoryByRange(total: number, read: RangeRead): Promise<RarDir> {
  if (!(total >= 20)) return Promise.reject(new Error('文件太小，不是有效的 RAR'));
  return parseRar(new Reader(read, total), total);
}
