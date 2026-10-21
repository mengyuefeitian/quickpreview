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
}

export interface ZipDir {
  entries: ZipDirEntry[];
  zip64: boolean;
}

const EOCD_SIG = 0x06054b50;      // 'PK\5\6'
const EOCD64_LOC_SIG = 0x07064b50; // 'PK\6\7'
const EOCD64_SIG = 0x06064b50;    // 'PK\6\6'
const CDH_SIG = 0x02014b50;       // 'PK\1\2'

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
  extra: DataView, size: number, csize: number
): { size: number; compressed: number } {
  let p = 0;
  let uncompressed = size;
  let compressed = csize;
  if (size === U32_MAX) { uncompressed = u64(extra, p); p += 8; }
  if (csize === U32_MAX) { compressed = u64(extra, p); p += 8; }
  return { size: uncompressed, compressed };
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
  let count = u16(dv, eocd + 10);
  let zip64 = false;

  // ZIP64：结尾记录前 20 字节是 ZIP64 定位器，真正的记录在它指的地方
  const loc = eocd - 20;
  if (loc >= 0 && u32(dv, loc) === EOCD64_LOC_SIG) {
    const e64 = u64(dv, loc + 8);
    if (e64 >= 0 && e64 + 56 <= len && u32(dv, e64) === EOCD64_SIG) {
      zip64 = true;
      count = u64(dv, e64 + 32);
      cdOffset = u64(dv, e64 + 48);
    }
  }

  // 条目数是 16 位的，被截断时（>65535）以实际遍历为准，别信它
  const entries: ZipDirEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    // 留 46 字节完整头部 + 至少 1 字节文件名
    if (p < 0 || p + 46 > len) break;
    if (u32(dv, p) !== CDH_SIG) {
      if (i === 0) throw new Error('中央目录偏移不对，文件结构已损坏');
      break;
    }

    const flags = u16(dv, p + 8);
    const method = u16(dv, p + 10);
    const date = dosDate(dv, p + 12);
    let size = u32(dv, p + 24);
    let compressed = u32(dv, p + 20);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const external = u32(dv, p + 38);

    const nameBytes = new Uint8Array(ab, p + 46, nameLen);
    const name = decodeName(nameBytes);

    if (extraLen > 0 && p + 46 + nameLen + extraLen <= len) {
      const extraBytes = new Uint8Array(ab, p + 46 + nameLen, extraLen);
      const z64 = findZip64Extra(extraBytes);
      if (z64) {
        const r = readZip64Extra(z64, size, compressed);
        size = r.size;
        compressed = r.compressed;
      }
    }

    const isDir = name.endsWith('/') || (external & 0x10) !== 0;

    entries.push({
      path: name.replace(/\/+$/, ''),
      dir: isDir,
      size,
      compressed,
      date,
      method,
      encrypted: (flags & 0x1) !== 0
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, zip64 };
}
