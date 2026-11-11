// docx 交给 docx-preview 之前的预处理（一个 zip 只解开 / 重打包一次）
//
// 已经有四件事必须在这里做，理由都是「库自己不做，而浏览器侧没救」：
//
// ① 页眉页脚继承
//   Word 的规则是「节内没写引用就继承上一节」：sectPr 里只有真正改过页眉的节才带
//   headerReference/footerReference，后面几十个节往往一个引用都没有，全靠继承。
//   docx-preview 不做继承（renderHeaderFooter 只在 refs 存在时渲染），
//   于是「第一节（封面）有页眉，后面所有页都没有」—— 实测 26 页的手册只有第 1 页有页眉页脚。
//   另外 titlePg（首页不同）在 docx-preview 里的回退是错的：
//     refs.find(first) ?? refs.find(default) —— 首页没有 first 引用时会退到 default，
//   于是封面被硬塞上正文的页眉页脚。Word 的语义是「首页用 first，没定义就是空白」。
//
// ② 编号「显式关闭」修正（numId=0）
//   标题 1/2/3 的编号来自样式里的 numPr；而「目录」这种本该没有编号的标题，
//   Word 的写法是样式里加 <w:numPr><w:numId w:val="0"/></w:numPr>（0 = 不要编号）。
//   docx-preview 的 processStyles 是 mergeDeep(style, baseStyle)，**基样式的值反过来
//   覆盖子样式**（与 Word 语义相反），于是 numId=0 被基样式的 numId=1 覆盖，
//   「目录」也被算进编号 ⇒ 后面所有章节号整体 +1（实测“5 功能说明”显示成“6 功能说明”）。
//   修法：给这类段落补一条**段落级** numPr numId=0 —— docx-preview 取
//   `elem.numbering ?? style.numbering`，段落级存在时直接生效，不参与样式合并。
//
// ③ 页码域（PAGE / NUMPAGES / SECTIONPAGES）
//   Word 里是复杂域：fldChar begin → instrText " PAGE \* MERGEFORMAT " → separate →
//   缓存的域结果("19") → end。docx-preview 直接丢掉指令、只把缓存结果当普通文字渲染，
//   于是 94 页的文档每页页脚都印着「第 19 页，共 19 页」。
//   修法：整个域替换成一个哨兵文本，分页完成后由 fillPageFields 逐页换成真实页码。
//
// ④ EMF / WMF 元文件
//   Word 的符号标记（警告/注意/说明/窍门）大多是 word/media/imageN.emf。
//   Chromium 不解码 EMF/WMF ⇒ <img> 的 naturalWidth=0，页面上是碎图标。
//   修法：请宿主用 GDI+ 光栅化成 PNG 顶掉原条目，并把 [Content_Types].xml 里
//   emf/wmf 的默认类型改成 image/png（docx-preview 是按 Content_Types 定 MIME 的，
//   不按扩展名猜）。
//
// 【为什么用字符串改写而不是 DOMParser】3MB 的手册实测：解析 + 序列化 320KB 的
// document.xml 要 200ms 上下，而只替换片段只要几毫秒；而且整篇 XML 过一遍
// XMLSerializer 还会顺带改动命名空间前缀、实体写法，风险比定点替换大得多。
// 代价是要自己认命名空间前缀 —— 从根元素的 xmlns 声明里取，取不到就放弃（返回 null）。
import JSZip from 'jszip';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const REL_HEADER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
const REL_FOOTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const CT_HEADER = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const CT_FOOTER = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

const BLANK_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
  + `<w:hdr xmlns:w="${NS_W}"><w:p/></w:hdr>`;
const BLANK_FOOTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
  + `<w:ftr xmlns:w="${NS_W}"><w:p/></w:ftr>`;

/** 页脚页码的哨兵（私用区字符，正文里不可能出现，替换漏了也只是显示成方块） */
export const MARK = {
  page: '\uE000P\uE001',
  numPages: '\uE000N\uE001',
  sections: '\uE000S\uE001'
} as const;

export interface DocxPrepInfo {
  /** 补出来的页眉页脚继承引用条数 */
  inherited: number;
  /** 为 titlePg 节补的空白首页页眉（+页脚）引用条数 */
  blankFirst: number;
  /** 节数 */
  sections: number;
  /** 为「numId=0」（显式不要编号）补段落级覆盖的条数 */
  numCleared: number;
  /** 换成哨兵的页码域个数 */
  fields: number;
  /** 成功转成 PNG 的元文件个数 */
  emf: number;
  /** 转换失败的元文件个数 */
  emfFailed: number;
  /** 分步耗时（毫秒），用来盯住预处理开销 */
  ms?: { load: number; xml: number; zip: number };
}

export interface DocxPrepOptions {
  /**
   * EMF/WMF → PNG。返回 PNG 的 base64；返回 null 表示这次转不了（保持原样）。
   * 页面侧由宿主实现（GDI+），非 WebView2 环境下没有这个能力。
   */
  emfToPng?: (base64: string) => Promise<string | null>;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// r:id 占位符：算完 rels 里的重名情况后统一替换成真实 id
const PH_HEADER = '__QP_BLANK_HEADER__';
const PH_FOOTER = '__QP_BLANK_FOOTER__';

function prefixOf(xml: string, ns: string): string | null {
  const m = new RegExp(`xmlns:([A-Za-z0-9_.-]+)="\\s*${esc(ns)}\\s*"`).exec(xml);
  return m ? m[1] : null;
}

function typeOf(ref: string, wp: string): string {
  const m = new RegExp(`${esc(wp)}:type="([^"]*)"`).exec(ref);
  return m ? m[1] : 'default';
}

// 把继承来的引用改成目标类型（没有 type 属性就在标签名后面补一个）
function retype(ref: string, wp: string, kind: string, type: string): string {
  const attr = new RegExp(`\\s${esc(wp)}:type="[^"]*"`);
  if (attr.test(ref)) return ref.replace(attr, ` ${wp}:type="${type}"`);
  return ref.replace(new RegExp(`^<${esc(wp)}:${kind}Reference\\b`), `<$& ${wp}:type="${type}"`);
}

// ---------- ① 页眉页脚继承 ----------
function fixHeaderFooterRefs(
  xml: string, wp: string, rp: string
): { xml: string; inherited: number; blankFirst: number; sections: number; needBlank: { header: boolean; footer: boolean } } {
  const needBlank = { header: false, footer: false };
  // 继承状态：按 type（default/first/even）记住上一节用的是什么引用原文
  const cur: Record<'header' | 'footer', Record<string, string | null>> = {
    header: { default: null, first: null, even: null },
    footer: { default: null, first: null, even: null },
  };
  let inherited = 0;
  let blankFirst = 0;
  let sections = 0;

  const sectRe = new RegExp(
    `<${esc(wp)}:sectPr\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:/>|>([\\s\\S]*?)</${esc(wp)}:sectPr>)`, 'g');

  const out = xml.replace(sectRe, (whole: string, attrs: string, bodyRaw?: string) => {
    const body = bodyRaw || '';
    sections++;
    const add: string[] = [];

    for (const kind of ['header', 'footer'] as const) {
      const refRe = new RegExp(`<${esc(wp)}:${kind}Reference\\b[^>]*/>`, 'g');
      const own = body.match(refRe) || [];
      const have = new Set(own.map((r) => typeOf(r, wp)));

      // 1) 缺失的类型从上一节继承（引用原文直接搬，只改 type）
      for (const t of ['default', 'first', 'even']) {
        const prev = cur[kind][t];
        if (!prev || have.has(t)) continue;
        add.push(retype(prev, wp, kind, t));
      }
      // 2) 记录本节当前生效的引用（own 覆盖继承值）；add 里的也要记，供下一节继续继承
      for (const r of own) cur[kind][typeOf(r, wp)] = r;
      for (const r of add) cur[kind][typeOf(r, wp)] = r;
      inherited += add.length;

      // 3) titlePg 且拿不到 first 引用 → 补一个指向空白部件的 first 引用
      const titlePg = new RegExp(`<${esc(wp)}:titlePg\\b([^>]*?)/?>`).exec(body);
      const disabled = new RegExp(`\\s${esc(wp)}:val="(0|false|off)"`);
      if (titlePg && !disabled.test(titlePg[1]) && !own.some((r) => typeOf(r, wp) === 'first')
        && cur[kind].default) {
        // 关系 id 先写占位符，等算过 rels 里的重名情况再统一替换
        const ph = kind === 'header' ? PH_HEADER : PH_FOOTER;
        const el = `<${wp}:${kind}Reference ${wp}:type="first" ${rp}:id="${ph}"/>`;
        add.push(el);
        cur[kind].first = el;
        needBlank[kind] = true;
        blankFirst++;
      }
    }

    if (!add.length) return whole;
    // 引用必须排在 sectPr 最前面（OOXML 子元素顺序是 schema 校验的）
    return `<${wp}:sectPr${attrs}>${add.join('')}${body}</${wp}:sectPr>`;
  });

  return { xml: out, inherited, blankFirst, sections, needBlank };
}

// ---------- ② 编号「显式关闭」修正 ----------

interface StyleNum {
  basedOn: string | null;
  /** 样式自身声明的 numId（"0" 表示显式不要编号；null 表示没声明） */
  numId: string | null;
}

function indexStyles(stylesXml: string, wp: string): Map<string, StyleNum> {
  const map = new Map<string, StyleNum>();
  const styleRe = new RegExp(`<${esc(wp)}:style\\b([^>]*)>([\\s\\S]*?)</${esc(wp)}:style>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = styleRe.exec(stylesXml))) {
    const idAttr = new RegExp(`\\s${esc(wp)}:styleId="([^"]*)"`).exec(m[1]);
    if (!idAttr) continue;
    const body = m[2];
    const based = new RegExp(`<${esc(wp)}:basedOn\\b[^>]*${esc(wp)}:val="([^"]*)"`).exec(body);
    const numPr = new RegExp(`<${esc(wp)}:numPr\\b[\\s\\S]*?</${esc(wp)}:numPr>`).exec(body);
    let numId: string | null = null;
    if (numPr) {
      const n = new RegExp(`<${esc(wp)}:numId\\b[^>]*${esc(wp)}:val="([^"]*)"`).exec(numPr[0]);
      if (n) numId = n[1];
      else numId = '0';      // 只有 ilvl 没 numId：按「没声明」处理更保守
    }
    map.set(idAttr[1], { basedOn: based ? based[1] : null, numId });
  }
  return map;
}

/** 沿 basedOn 链取「第一个声明了 numId 的样式」的值（Word 的继承语义） */
function effectiveNumId(styles: Map<string, StyleNum>, id: string): string | null {
  let cur: string | null = id;
  for (let i = 0; i < 12 && cur; i++) {
    const s = styles.get(cur);
    if (!s) return null;
    if (s.numId != null) return s.numId;
    cur = s.basedOn;
  }
  return null;
}

// pPr 里必须排在 numPr 之前的元素（schema 顺序：pStyle → keepNext → keepLines →
// pageBreakBefore → framePr → widowControl → numPr）。补 numPr 时要跳过它们。
const BEFORE_NUMPR = ['keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl'];

function clearDisabledNumbering(xml: string, styles: Map<string, StyleNum>, wp: string): { xml: string; fixed: number } {
  const pStyleRe = new RegExp(`<${esc(wp)}:pStyle\\b[^>]*${esc(wp)}:val="([^"]*)"[^>]*/>`, 'g');
  const inserts: number[] = [];
  let m: RegExpExecArray | null;

  while ((m = pStyleRe.exec(xml))) {
    if (effectiveNumId(styles, m[1]) !== '0') continue;

    const idx = m.index;
    const end = idx + m[0].length;

    // 必须属于本段落（跳过被嵌套文本框段落包住的情况：中间已经出现 </w:p>）
    const paraStart = xml.lastIndexOf(`<${wp}:p `, idx) >= 0
      ? xml.lastIndexOf(`<${wp}:p `, idx) : xml.lastIndexOf(`<${wp}:p>`, idx);
    if (paraStart < 0) continue;
    const between = xml.slice(paraStart, idx);
    if (between.includes(`</${wp}:p>`)) continue;

    // 段落自己已经有 numPr 就不用管（docx-preview 会优先用段落级）
    const pPrEnd = xml.indexOf(`</${wp}:pPr>`, end);
    if (pPrEnd < 0) continue;
    const pPrBody = xml.slice(end, pPrEnd);
    if (pPrBody.includes(`<${wp}:numPr`)) continue;

    // 跳过必须排在 numPr 前面的那几个空元素
    let pos = end;
    for (;;) {
      const next = new RegExp(`^\\s*<${esc(wp)}:(${BEFORE_NUMPR.join('|')})\\b[^>]*/>`).exec(xml.slice(pos, pos + 200));
      if (!next) break;
      pos += next[0].length;
    }
    inserts.push(pos);
  }

  if (!inserts.length) return { xml, fixed: 0 };

  let out = xml;
  const tag = `<${wp}:numPr><${wp}:ilvl ${wp}:val="0"/><${wp}:numId ${wp}:val="0"/></${wp}:numPr>`;
  for (let i = inserts.length - 1; i >= 0; i--) {
    const p = inserts[i];
    out = out.slice(0, p) + tag + out.slice(p);
  }
  return { xml: out, fixed: inserts.length };
}

// ---------- ③ 页码域 → 哨兵 ----------

type FieldKind = 'page' | 'numPages' | 'sections';

function fieldKindOf(instr: string): FieldKind | null {
  const s = instr.replace(/\s+/g, ' ').trim();
  // PAGEREF / NUMPAGESXYZ 之类不能误判：关键字后面必须不是字母
  if (/^SECTIONPAGES(?![A-Za-z])/i.test(s)) return 'sections';
  if (/^NUMPAGES(?![A-Za-z])/i.test(s)) return 'numPages';
  if (/^PAGE(?![A-Za-z])/i.test(s)) return 'page';
  return null;
}

const MARK_OF: Record<FieldKind, string> = {
  page: MARK.page, numPages: MARK.numPages, sections: MARK.sections
};

/** 把一段 xml 里的页码域整体换成哨兵；返回新的 xml 与替换个数 */
export function markPageFields(xml: string, wp: string): { xml: string; fields: number } {
  let count = 0;
  let out = xml;

  // (a) 简单域 w:fldSimple（带 instr 属性，内容就是缓存结果）
  const simpleRe = new RegExp(
    `<${esc(wp)}:fldSimple\\b([^>]*)>([\\s\\S]*?)</${esc(wp)}:fldSimple>`, 'g');
  out = out.replace(simpleRe, (whole: string, attrs: string, body: string) => {
    const instr = new RegExp(`${esc(wp)}:instr="([^"]*)"`).exec(attrs);
    const kind = instr ? fieldKindOf(instr[1]) : null;
    if (!kind) return whole;
    count++;
    const rPr = new RegExp(`<${esc(wp)}:rPr>[\\s\\S]*?</${esc(wp)}:rPr>`).exec(body);
    return `<${wp}:r>${rPr ? rPr[0] : ''}<${wp}:t xml:space="preserve">${MARK_OF[kind]}</${wp}:t></${wp}:r>`;
  });

  // (b) 复杂域：连续的 w:r 里 begin → instrText → separate → 结果 → end
  const runRe = new RegExp(
    `<${esc(wp)}:r\\b[^>]*/>|<${esc(wp)}:r\\b[^>]*>[\\s\\S]*?</${esc(wp)}:r>`, 'g');
  const runs: { start: number; end: number; kind: string; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(xml))) {
    const s = m[0];
    let kind = 'other';
    if (new RegExp(`<${esc(wp)}:fldChar\\b[^>]*${esc(wp)}:fldCharType="begin"`).test(s)) kind = 'begin';
    else if (new RegExp(`<${esc(wp)}:fldChar\\b[^>]*${esc(wp)}:fldCharType="separate"`).test(s)) kind = 'separate';
    else if (new RegExp(`<${esc(wp)}:fldChar\\b[^>]*${esc(wp)}:fldCharType="end"`).test(s)) kind = 'end';
    else if (s.includes(`<${wp}:instrText`)) kind = 'instr';
    runs.push({ start: m.index, end: m.index + s.length, kind, text: s });
  }

  const cuts: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].kind !== 'begin') continue;
    const beginIdx = i;
    let depth = 1, instr = '', sep = -1, j = i + 1;
    for (; j < runs.length; j++) {
      if (runs[j].kind === 'begin') depth++;
      else if (runs[j].kind === 'end') { depth--; if (depth === 0) break; }
      else if (runs[j].kind === 'instr' && depth === 1) {
        const t = new RegExp(`<${esc(wp)}:instrText\\b[^>]*>([\\s\\S]*?)</${esc(wp)}:instrText>`).exec(runs[j].text);
        if (t) instr += t[1];
      } else if (runs[j].kind === 'separate' && depth === 1 && sep < 0) sep = j;
    }
    if (j >= runs.length) break;                             // 域没闭合，别动
    const kind = fieldKindOf(instr.replace(/&amp;/g, '&'));
    i = j;
    if (!kind) continue;
    count++;

    // 结果的字符格式取「separate 之后第一个 run 的 rPr」，没有就退回 begin 那个 run
    let rPr = '';
    for (let k = sep >= 0 ? sep + 1 : beginIdx; k < j; k++) {
      const found = new RegExp(`<${esc(wp)}:rPr>[\\s\\S]*?</${esc(wp)}:rPr>`).exec(runs[k].text);
      if (found) { rPr = found[0]; break; }
    }
    cuts.push({
      start: runs[beginIdx].start,
      end: runs[j].end,
      text: `<${wp}:r>${rPr}<${wp}:t xml:space="preserve">${MARK_OF[kind]}</${wp}:t></${wp}:r>`
    });
  }

  // 从后往前替换，前面的下标不会失效
  for (let k = cuts.length - 1; k >= 0; k--) {
    const c = cuts[k];
    out = out.slice(0, c.start) + c.text + out.slice(c.end);
  }
  return { xml: out, fields: count };
}

// ---------- 分页之后：哨兵 → 真实页码 ----------

/**
 * 把某一页页眉页脚里的页码哨兵换成真实页号。
 * 必须在分页（页数已确定）之后对每一页调用一次；页眉页脚是多页复制的，
 * 同一个哨兵会出现在每一页的副本里。
 */
export function fillPageFields(root: ParentNode, pageNo: number, total: number): number {
  const anyRoot = root as any;
  const doc: Document = anyRoot.ownerDocument || anyRoot;
  const walker = doc.createTreeWalker(root as unknown as Node, 4 /* NodeFilter.SHOW_TEXT */);

  let n = 0;
  const hits: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const v = t.nodeValue;
    if (v && v.indexOf('\uE000') >= 0) hits.push(t);
  }
  for (const t of hits) {
    const v = t.nodeValue || '';
    const nv = v
      .split(MARK.page).join(String(pageNo))
      .split(MARK.numPages).join(String(total))
      .split(MARK.sections).join(String(total));
    if (nv !== v) { t.nodeValue = nv; n++; }
  }
  return n;
}

// ---------- ④ EMF / WMF → PNG ----------

async function convertMetafiles(
  zip: JSZip, options: DocxPrepOptions
): Promise<{ ok: number; failed: number; exts: Set<string> }> {
  const exts = new Set<string>();
  let ok = 0, failed = 0;
  if (!options.emfToPng) return { ok, failed, exts };

  const names = Object.keys(zip.files).filter((n) => /^word\/media\/[^/]+\.(emf|wmf)$/i.test(n));
  for (const name of names) {
    const f = zip.file(name);
    if (!f) continue;
    try {
      const b64 = await f.async('base64');
      const png64 = await options.emfToPng(b64);
      if (!png64) { failed++; continue; }
      const bin = atob(png64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      zip.file(name, bytes);
      exts.add(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed, exts };
}

// ---------- 入口 ----------

/**
 * 返回预处理后的 docx；完全不需要修改（或不是 docx / 解析失败）时返回 null，调用方用原数据。
 */
export async function prepareDocx(
  ab: ArrayBuffer, options: DocxPrepOptions = {}
): Promise<{ data: Blob; info: DocxPrepInfo } | null> {
  const tA = Date.now();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(ab);
  } catch {
    return null;
  }
  const docFile = zip.file('word/document.xml');
  if (!docFile) return null;

  const tB = Date.now();
  let xml = await docFile.async('string');

  const wp = prefixOf(xml, NS_W);
  const rp = prefixOf(xml, NS_R);
  if (!wp || !rp) return null;

  let changed = false;

  // ① 页眉页脚继承
  let inherited = 0, blankFirst = 0, sections = 0;
  const needBlank = { header: false, footer: false };
  if (new RegExp(`<${esc(wp)}:(header|footer)Reference\\b`).test(xml)) {
    const r = fixHeaderFooterRefs(xml, wp, rp);
    sections = r.sections;
    if (r.inherited || r.blankFirst) {
      xml = r.xml;
      inherited = r.inherited;
      blankFirst = r.blankFirst;
      needBlank.header = r.needBlank.header;
      needBlank.footer = r.needBlank.footer;
      changed = true;
    }
  }

  // ② numId=0（显式不要编号）
  let numCleared = 0;
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    const stylesXml = await stylesFile.async('string');
    const styles = indexStyles(stylesXml, wp);
    const r = clearDisabledNumbering(xml, styles, wp);
    if (r.fixed) {
      xml = r.xml;
      numCleared = r.fixed;
      changed = true;
    }
  }

  // ③ 页眉页脚部件里的页码域
  let fields = 0;
  const parts = Object.keys(zip.files).filter((n) => /^word\/(header|footer)[^/]*\.xml$/i.test(n));
  for (const name of parts) {
    const f = zip.file(name);
    if (!f) continue;
    const src = await f.async('string');
    const r = markPageFields(src, wp);
    if (!r.fields) continue;
    zip.file(name, r.xml);
    fields += r.fields;
    changed = true;
  }

  const tC = Date.now();

  // ④ 元文件转换（要等宿主回话，放在最后做，前面的纯字符串活先干完）
  const emf = await convertMetafiles(zip, options);
  if (emf.exts.size) {
    const ctFile = zip.file('[Content_Types].xml');
    if (ctFile) {
      let ct = await ctFile.async('string');
      for (const ext of emf.exts) {
        const re = new RegExp(`<Default\\b[^>]*Extension="${esc(ext)}"[^>]*/>`, 'i');
        if (re.test(ct)) ct = ct.replace(re, `<Default Extension="${ext}" ContentType="image/png"/>`);
        else ct = ct.replace(/<\/Types>\s*$/, `<Default Extension="${ext}" ContentType="image/png"/></Types>`);
      }
      zip.file('[Content_Types].xml', ct);
    }
    changed = true;
  }

  if (!changed) return null;

  let docXml = xml;

  if (needBlank.header || needBlank.footer) {
    if (needBlank.header) zip.file('word/headerQpBlank.xml', BLANK_HEADER);
    if (needBlank.footer) zip.file('word/footerQpBlank.xml', BLANK_FOOTER);

    const relFile = zip.file('word/_rels/document.xml.rels');
    if (relFile) {
      const rels = await relFile.async('string');
      const used = new Set(Array.from(rels.matchAll(/\bId="([^"]*)"/g), (m) => m[1]));
      const extra: string[] = [];
      const addRel = (base: string, ph: string, type: string, target: string): void => {
        let id = base;
        let n = 1;
        while (used.has(id)) id = `${base}_${n++}`;   // 撞了就换一个，占位符一并替换
        used.add(id);
        extra.push(`<Relationship Id="${id}" Type="${type}" Target="${target}"/>`);
        docXml = docXml.split(ph).join(id);
      };
      if (needBlank.header) addRel('rIdQpBlankHeader', PH_HEADER, REL_HEADER, 'headerQpBlank.xml');
      if (needBlank.footer) addRel('rIdQpBlankFooter', PH_FOOTER, REL_FOOTER, 'footerQpBlank.xml');
      zip.file('word/_rels/document.xml.rels',
        rels.replace(/<\/Relationships>\s*$/, `${extra.join('')}</Relationships>`));
    }

    const ctFile = zip.file('[Content_Types].xml');
    if (ctFile) {
      const ct = await ctFile.async('string');
      const extra: string[] = [];
      if (needBlank.header) {
        extra.push(`<Override PartName="/word/headerQpBlank.xml" ContentType="${CT_HEADER}"/>`);
      }
      if (needBlank.footer) {
        extra.push(`<Override PartName="/word/footerQpBlank.xml" ContentType="${CT_FOOTER}"/>`);
      }
      zip.file('[Content_Types].xml', ct.replace(/<\/Types>\s*$/, `${extra.join('')}</Types>`));
    }
  }

  zip.file('word/document.xml', docXml);

  const tD = Date.now();
  // level 1：这是内存里的临时包，压得越小越慢没必要；图片本身已是压缩格式，重压也不会更小
  const data = await zip.generateAsync({
    type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 }
  });
  const tE = Date.now();
  return {
    data,
    info: {
      inherited, blankFirst, sections, numCleared, fields,
      emf: emf.ok, emfFailed: emf.failed,
      ms: { load: tB - tA, xml: tC - tB, zip: tE - tD }
    }
  };
}
