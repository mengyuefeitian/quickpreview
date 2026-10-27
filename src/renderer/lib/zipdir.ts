// ZIP 中央目录直读（不解压、不需要密码、不依赖 JSZip）
//
// 存在的理由：JSZip 一遇到「加密条目」或「它不认识的压缩算法」就直接整体抛错
// （`Encrypted zip are not supported`），连文件清单都列不出来。
// 但 ZIP 的中央目录是明文结构 —— 文件名、大小、时间戳都在里面，
// 加密的只是**数据区**，清单本身不需要解密。
//
// 于是：任何 JSZip 读不了的包，都还能退化成「只列清单」，
// 用户至少看得见包里有什么、每个文件多大、什么时候改的。
//
// 覆盖范围：普通 ZIP、ZIP64（>4GB / >65535 条目）、UTF-8 与 GBK 文件名。

export interface ZipDirEntry {
  path: string;
  dir: boolean;
  size: number;          // 解压后大小
  compressed: number;    // 压缩后大小
  date: Date | null;
  method: number;        // 压缩方法（见 METHOD_NAME）
  encrypted: boolean;
  /** 本地文件头在包内的绝对偏移。大包按区间取内容时靠它定位。 */
  offset: number;
}

export interface ZipDir {
  entries: ZipDirEntry[];
  zip64: boolean;
}

const EOCD_SIG = 0x06054b50;      // 'PK\5\6'
const EOCD64_LOC_SIG = 0x07064b50; // 'PK\6\7'
const EOCD64_SIG = 0x06064b50;    // 'PK\6\6'
const CDH_SIG = 0x02014b50;       // 'PK\1\2'
const LOCAL_SIG = 0x04034b50;     // 'PK\3\4'

const U32_MAX = 0xffffffff;

/** 压缩方法 → 名称。99 是 WinZip AES 加密，不是真正的"算法"。 */
export const METHOD_NAME: Record<number, string> = {
  0: '存储',
  1: 'Shrink',
  6: 'Implode',
  8: 'Deflate',
  9: 'Deflate64',
  12: 'BZip2',
  14: 'LZMA',
  93: 'Zstandard',
  96: 'JPEG',
  98: 'PPMd',
  99: 'AES 加密'
};

/** 本机（JSZip）能解压的方法：只有存储和 Deflate。 */
const SUPPORTED_METHODS = new Set([0, 8]);

export function methodLabel(m: number): string {
  return METHOD_NAME[m] || ('未知算法 ' + m);
}

export function methodReadable(m: number): boolean {
  return SUPPORTED_METHODS.has(m);
}

function u16(d: DataView, o: number): number {
  return d.getUint16(o, true);
}

function u32(d: DataView, o: number): number {
  return d.getUint32(o, true);
}

/** 读 8 字节小端整数。ZIP 单文件最大 16EB，这里到 2^53 内精度足够（显示只用到 GB 级）。 */
function u64(d: DataView, o: number): number {
  return d.getUint32(o + 4, true) * 4294967296 + d.getUint32(o, true);
}

/**
 * 从文件尾部找 EOCD。
 * 结尾记录固定在文件末尾，但后面最多可跟 64KB 注释，所以从尾往前扫。
 * 先用"注释长度能对上文件尾"做一次严格校验，防止正文里恰好有同样的字节序列被误判。
 */
function findEocd(dv: DataView, len: number): number {
  const maxBack = Math.min(len - 22, 65535);
  for (let i = 0; i <= maxBack; i++) {
    const pos = len - 22 - i;
    if (pos < 0) break;
    if (u32(dv, pos) !== EOCD_SIG) continue;
    const commentLen = u16(dv, pos + 20);
    if (pos + 22 + commentLen === len) return pos;
  }
  // 有些工具注释长度写得不准，放宽再扫一遍
  for (let i = 0; i <= maxBack; i++) {
    const pos = len - 22 - i;
    if (pos < 0) break;
    if (u32(dv, pos) === EOCD_SIG) return pos;
  }
  return -1;
}

/** DOS 时间戳 → Date。ZIP 里存的是本地时间，没有时区信息。 */
function dosDate(dv: DataView, o: number): Date | null {
  const t = u16(dv, o);
  const d = u16(dv, o + 2);
  if (!d) return null;
  const year = ((d >> 9) & 0x7f) + 1980;
  const month = (d >> 5) & 0x0f;
  const day = d & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day, (t >> 11) & 0x1f, (t >> 5) & 0x3f, (t & 0x1f) * 2);
}

/**
 * 文件名解码。
 *
 * ZIP 规范里标志位第 11 位（0x800）表示「文件名是 UTF-8」，但**很多压缩工具不写这个位**，
 * 包括存的是 UTF-8 名字的时候。所以不能依赖标志位，得靠内容判断：
 *
 * 顺序必须是「先 UTF-8，再 GBK」：
 * · UTF-8 有严格的自校验（首字节决定后续字节必须落在 0x80–0xBF），
 *   GBK 的中文字节序列几乎不可能碰巧合法 —— 所以 UTF-8 解码成功即可信；
 * · 反过来不行：GBK 几乎能把任意字节序列都"解出来"，且不出替换字符（U+FFFD），
 *   用它解 UTF-8 名字会得到「涓枃鏂囦欢.txt」这种乱码，且发现不了。
 */
function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* 不是 UTF-8，按 GBK 试 */ }

  try {
    const s = new TextDecoder('gbk').decode(bytes);
    if (s && !s.includes('\uFFFD')) return s;
  } catch { /* 环境不支持 gbk，走兜底 */ }

  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * 解析 ZIP64 扩展字段（header id 0x0001）。
 * 字段是变长的：只有相应位置被 0xFFFFFFFF 占位时才出现，且顺序固定为
 * 原始大小 → 压缩大小 → 本地头偏移 → 磁盘号。必须按这个顺序消费，不能按偏移硬取。
 */
function readZip64Extra(
  extra: DataView, size: number, csize: number, offset: number
): { size: number; compressed: number; offset: number } {
  let p = 0;
  let uncompressed = size;
  let compressed = csize;
  let off = offset;
  if (size === U32_MAX) { uncompressed = u64(extra, p); p += 8; }
  if (csize === U32_MAX) { compressed = u64(extra, p); p += 8; }
  if (offset === U32_MAX) { off = u64(extra, p); p += 8; }
  return { size: uncompressed, compressed, offset: off };
}

/** 在扩展字段区里找出 ZIP64 头（id 0x0001）。 */
function findZip64Extra(bytes: Uint8Array): DataView | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (p + 4 <= bytes.length) {
    const id = u16(dv, p);
    const len = u16(dv, p + 2);
    if (p + 4 + len > bytes.length) break;
    if (id === 0x0001) {
      return new DataView(bytes.buffer, bytes.byteOffset + p + 4, len);
    }
    p += 4 + len;
  }
  return null;
}

/** 解析一段中央目录字节。`absBase` 是这段字节在包内的起始偏移，用来换算本地头绝对位置。 */
function parseCentralDirectory(bytes: Uint8Array, absBase: number, count: number): ZipDirEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  const entries: ZipDirEntry[] = [];
  let p = 0;

  for (let i = 0; i < count; i++) {
    // 留 46 字节完整头部 + 至少 1 字节文件名
    if (p + 46 > len) break;
    if (u32(dv, p) !== CDH_SIG) {
      if (i === 0) throw new Error('中央目录偏移不对，文件结构已损坏');
      break;
    }

    const flags = u16(dv, p + 8);
    const method = u16(dv, p + 10);
    const date = dosDate(dv, p + 12);
    let size = u32(dv, p + 24);
    let compressed = u32(dv, p + 20);
    let offset = u32(dv, p + 42);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const external = u32(dv, p + 38);

    if (p + 46 + nameLen > len) break;
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen));

    if (extraLen > 0 && p + 46 + nameLen + extraLen <= len) {
      const z64 = findZip64Extra(bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
      if (z64) {
        const r = readZip64Extra(z64, size, compressed, offset);
        size = r.size;
        compressed = r.compressed;
        offset = r.offset;
      }
    }

    entries.push({
      path: name.replace(/\/+$/, ''),
      dir: name.endsWith('/') || (external & 0x10) !== 0,
      size,
      compressed,
      date,
      method,
      encrypted: (flags & 0x1) !== 0,
      offset
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * 直读 ZIP 中央目录，返回条目清单。
 * 只读结构，不碰数据区 —— 所以加密包、ZIP64 超大包、用了冷门算法的包都能读。
 */
export function readZipDirectory(ab: ArrayBuffer): ZipDir {
  const dv = new DataView(ab);
  const len = dv.byteLength;

  if (len < 22) throw new Error('文件太小，不是有效的 ZIP');

  const eocd = findEocd(dv, len);
  if (eocd < 0) throw new Error('找不到 ZIP 结尾记录（文件可能已损坏或不是 ZIP）');

  let cdOffset = u32(dv, eocd + 16);
  let cdSize = u32(dv, eocd + 12);
  let count: number = u16(dv, eocd + 10);
  let zip64 = false;

  // ZIP64：结尾记录前 20 字节是 ZIP64 定位器，真正的记录在它指的地方
  const loc = eocd - 20;
  if (loc >= 0 && u32(dv, loc) === EOCD64_LOC_SIG) {
    const e64 = u64(dv, loc + 8);
    if (e64 >= 0 && e64 + 56 <= len && u32(dv, e64) === EOCD64_SIG) {
      zip64 = true;
      count = u64(dv, e64 + 32);
      cdSize = u64(dv, e64 + 40);
      cdOffset = u64(dv, e64 + 48);
    }
  }

  // 条目数是 16 位的，被截断时（>65535）以实际遍历为准，别信它
  if (count === 0xffff) count = Infinity;
  if (cdOffset >= len) throw new Error('中央目录偏移越界，文件结构已损坏');

  const avail = Math.max(0, cdSize > 0 ? Math.min(cdSize, len - cdOffset) : len - cdOffset);
  const bytes = new Uint8Array(ab, cdOffset, avail);
  return { entries: parseCentralDirectory(bytes, cdOffset, count), zip64 };
}

// ---------------------------------------------------------------------------
// 按字节区间读取（大压缩包用）
//
// 1.5GB 的包不能整份读进渲染进程：fetch 全量会走 200 响应，把 1.5GB 一次塞给
// WebView2，浏览器进程直接被打爆、连带宿主一起退出（与当年播大视频崩溃同一机制）。
// 所以改成分片：先读文件尾找 EOCD，再按需抓中央目录，条目内容单独抓。
//
// 单片上限必须小于宿主 MaxRangeChunk（8MB），否则后面的字节会被静默截断。
// ---------------------------------------------------------------------------

/** 读 [start, end] 闭区间字节。 */
export type RangeRead = (start: number, end: number) => Promise<Uint8Array>;

/** 单次区间请求的字节数，留一半余量给宿主 8MB 上限。 */
export const RANGE_CHUNK = 4 * 1024 * 1024;
/** 中央目录最多读这么多；超出只解析前面能拿到的部分（够列清单）。 */
const CD_READ_MAX = 32 * 1024 * 1024;
/** 尾部扫描区：EOCD 最多后跟 64KB 注释。 */
const TAIL_LEN = 128 * 1024;

/** 分片读完 [start, start+length) 并拼成一整块。 */
export async function readRangeChunks(
  read: RangeRead, start: number, length: number, chunk = RANGE_CHUNK
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const n = Math.min(chunk, length - done);
    const part = await read(start + done, start + done + n - 1);
    if (part.length !== n) {
      throw new Error(`区间读取长度不符（期望 ${n}，实际 ${part.length}）`);
    }
    out.set(part, done);
    done += n;
  }
  return out;
}

/**
 * 只靠区间请求读出中央目录。大压缩包走这条路。
 * @param total 文件总长度
 * @param read  区间读取函数（测试里可以换成读本地文件）
 */
export async function readZipDirectoryByRange(total: number, read: RangeRead): Promise<ZipDir> {
  if (!(total >= 22)) throw new Error('文件太小，不是有效的 ZIP');

  const tailLen = Math.min(total, TAIL_LEN);
  const tailBase = total - tailLen;
  const tail = await read(tailBase, total - 1);
  const td = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  // findEocd 用「注释长度正好对到缓冲区末尾」做校验，这里缓冲区末尾就是文件末尾
  const eocdRel = findEocd(td, tail.length);
  if (eocdRel < 0) throw new Error('找不到 ZIP 结尾记录（文件可能已损坏或不是 ZIP）');

  let cdOffset = u32(td, eocdRel + 16);
  let cdSize = u32(td, eocdRel + 12);
  let count: number = u16(td, eocdRel + 10);
  let zip64 = false;

  const locRel = eocdRel - 20;
  if (locRel >= 0 && u32(td, locRel) === EOCD64_LOC_SIG) {
    const e64 = u64(td, locRel + 8);
    if (e64 > 0 && e64 + 56 <= total) {
      const rec = await read(e64, e64 + 55);
      const rd = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
      if (rec.length >= 56 && u32(rd, 0) === EOCD64_SIG) {
        zip64 = true;
        count = u64(rd, 32);
        cdSize = u64(rd, 40);
        cdOffset = u64(rd, 48);
      }
    }
  }

  if (count === 0xffff) count = Infinity;
  if (cdOffset >= total) throw new Error('中央目录偏移越界，文件结构已损坏');

  const want = Math.max(0, Math.min(
    cdSize > 0 ? cdSize : total - cdOffset,
    CD_READ_MAX,
    total - cdOffset
  ));
  const bytes = await readRangeChunks(read, cdOffset, want);
  return { entries: parseCentralDirectory(bytes, cdOffset, count), zip64 };
}

/** 单个条目允许内联预览的压缩后大小上限，超过就只提示、不下载数据区。 */
export const ENTRY_READ_MAX = 64 * 1024 * 1024;

/**
 * 按区间取出一个条目的内容并解压。
 * 只支持存储（0）与 Deflate（8）—— 这两种覆盖了 99% 的包；
 * 其它算法（BZip2/LZMA/Zstd…）在浏览器里本来也没有解压器。
 */
export async function extractEntryByRange(e: ZipDirEntry, read: RangeRead): Promise<ArrayBuffer> {
  if (e.encrypted) throw new Error('该文件已加密，需要密码才能解压');
  if (!methodReadable(e.method)) {
    throw new Error(`该文件使用 ${methodLabel(e.method)} 压缩，暂不支持直接预览`);
  }
  if (e.compressed <= 0) return new ArrayBuffer(0);
  if (e.compressed > ENTRY_READ_MAX) {
    throw new Error(`单个文件过大（压缩后 ${Math.round(e.compressed / 1048576)} MB），不适合在预览里解压`);
  }

  // 本地头里再取一次文件名/扩展字段长度：中央目录不记录这两个长度，
  // 而数据区紧跟在「本地头 + 文件名 + 扩展字段」之后。
  const hdr = await read(e.offset, e.offset + 29);
  const hd = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
  if (hdr.length < 30 || u32(hd, 0) !== LOCAL_SIG) {
    throw new Error('本地文件头损坏，无法定位数据');
  }
  const nameLen = u16(hd, 26);
  const extraLen = u16(hd, 28);
  const dataStart = e.offset + 30 + nameLen + extraLen;

  const raw = await readRangeChunks(read, dataStart, e.compressed);
  if (e.method === 0) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }

  const stream = new Blob([raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).arrayBuffer();
}
