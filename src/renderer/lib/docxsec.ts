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
  /** 自检发现「被我们改坏」而放弃修改的部件（宁可页码不准，也不能让全篇降级成纯文本） */
  broken?: string[];
  /**
   * 首屏迷你包：只含 document.xml 的前 N 个块级元素，其余部件（styles / numbering /
   * media / 页眉页脚）原样保留。用它先把前几页渲染出来，用户不用等整篇。
   * 截断点之后的内容不在包里，所以只能显示前几页；整篇渲染完再把后面的页接上。
   */
  mini?: {
    data: Blob; totalBlocks: number; usedBlocks: number;
    /**
     * 切点是否正好落在第 1 节的末尾。
     *
     * true ⇒ 迷你包完整覆盖了第 1 节，它的第 1 页就是最终的第 1 页，
     * 调用方可以**直接留用**、只把整篇的第 2 节之后接上去（换装时第 1 页一个像素都不动）。
     * false ⇒ 节太长，在节内截断的：迷你包只有这一节的前半段，
     * 只能当"临时占位"，整篇渲染完必须重切。
     */
    atSectionEnd: boolean;
  };
  /**
   * 正文第一个段落带「段前分页」（直接声明或沿 basedOn 继承）。
   *
   * Word 忽略这种情况下的分页，docx-preview 不忽略 —— 它会先切出一张只有页眉页脚的
   * 空白页当第 1 页。调用方拿到 true 时应当把渲染结果里的第 1 个空 section 丢掉。
   */
  dropFirstBlankPage?: boolean;
  /**
   * 分步耗时（毫秒），用来盯住预处理开销。
   * load 解包 / xml 取 document.xml / hf 页眉页脚继承 / num 编号清理 /
   * fields 页脚页码域 / emf 元文件光栅化 / check 整篇 XML 自检 / zip 重打包
   */
  ms?: {
    load: number; xml: number; hf?: number; num?: number; fields?: number;
    emf?: number; check?: number; mini?: number; zip: number;
  };
}

/**
 * 改完自检：能不能被当成 XML 解析。
 *
 * 【为什么必须有】这些替换都是字符串手术，篇幅一大就容易切在标签中间。一旦产出
 * 不是 well-formed XML，docx-preview 会在解析阶段直接抛错，整个预览退化成纯文本 ——
 * 114MB 的那份 NGSOC 手册就是这么被页脚里的文本框撞坏的
 * （`Unexpected closing tag: w:txbxContent != w:ftr`）。
 * 与其让一个页脚把全篇拖下水，不如牺牲那一个页脚。
 */
function xmlOk(s: string): boolean {
  try {
    const d = new DOMParser().parseFromString(s, 'application/xml');
    return d.getElementsByTagName('parsererror').length === 0;
  } catch {
    return false;
  }
}

/**
 * 轻量 XML 结构自检：只回答一个问题 ——「标签还配对吗」。
 *
 * 【为什么不能只用 DOMParser】它是全文建树。109MB 的手册 document.xml 有 25MB 上下，
 * 一次 parseFromString 实测 **2760ms**，而整段预处理才 3785ms —— 自检占 73%，
 * 偏偏这一段就压在用户等着看第一眼的时候。
 *
 * 我们真正要防的错误只有一类：字符串定点替换把标签切坏了
 * （踩过：页脚文本框被页码域替换成 `Unexpected closing tag: w:txbxContent != w:ftr`，
 * 整篇降级成纯文本）。这类错误的全部表现就是「开闭标签不配对 / 闭合顺序错」，
 * 单遍扫描足以发现，成本降一个数量级（25MB 约 80ms）。
 *
 * 它比 DOMParser 宽松的地方（重复属性、非法字符、命名空间前缀、属性未加引号）
 * 都不是我们的替换能制造出来的；真有漏网，靠下面的 xmlOkAny 复核兜住。
 */
function xmlOkFast(s: string): boolean {
  const stack: string[] = [];
  const n = s.length;
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) !== 60 /* < */) continue;
    const c = s.charCodeAt(i + 1);

    // 注释 / CDATA / DOCTYPE / 处理指令：整段跳过，不看里面的内容
    if (c === 33 /* ! */) {
      if (s.startsWith('<!--', i)) { const j = s.indexOf('-->', i + 4); if (j < 0) return false; i = j + 2; }
      else if (s.startsWith('<![CDATA[', i)) { const j = s.indexOf(']]>', i + 9); if (j < 0) return false; i = j + 2; }
      else { const j = s.indexOf('>', i); if (j < 0) return false; i = j; }
      continue;
    }
    if (c === 63 /* ? */) { const j = s.indexOf('?>', i + 2); if (j < 0) return false; i = j + 1; continue; }

    // 找这个标签的 '>'：属性值里的 '>' 不算
    let j = i + 1;
    let quote = 0;
    for (; j < n; j++) {
      const ch = s.charCodeAt(j);
      if (quote) { if (ch === quote) quote = 0; continue; }
      if (ch === 34 /* " */ || ch === 39 /* ' */) quote = ch;
      else if (ch === 62 /* > */) break;
    }
    if (j >= n) return false;

    const closing = s.charCodeAt(i + 1) === 47 /* / */;
    const selfClose = s.charCodeAt(j - 1) === 47;
    let k = closing ? i + 2 : i + 1;
    let nameEnd = k;
    while (nameEnd < j) {
      const ch = s.charCodeAt(nameEnd);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47) break;
      nameEnd++;
    }
    const name = s.slice(k, nameEnd);
    if (!name) return false;

    if (closing) {
      if (stack.pop() !== name) return false;
    } else if (!selfClose) {
      stack.push(name);
    }
    i = j;
  }
  return stack.length === 0;
}

/**
 * 自检入口：先轻量扫，**只有扫不过才**退回 DOMParser 复核。
 * 宁可多花一次全文解析，也不要把好文档误判成坏的（那会让整篇降级成纯文本）。
 */
function xmlOkAny(s: string): boolean {
  return xmlOkFast(s) || xmlOk(s);
}

export interface DocxPrepOptions {
  /**
   * EMF/WMF → PNG。返回 PNG 的 base64；返回 null 表示这次转不了（保持原样）。
   * 页面侧由宿主实现（GDI+），非 WebView2 环境下没有这个能力。
   */
  emfToPng?: (base64: string) => Promise<string | null>;
  /** 元文件转换进度（已处理 / 总数）。几十个元文件串行转换要十秒上下，必须报进度。 */
  onProgress?: (done: number, total: number) => void;
  /**
   * 首屏迷你包做好时回调，**在整篇重打包之前**。调用方可以在这里把第 1 页先画出来，
   * 用户就不用等整篇渲染。抛错会被吞掉，不影响后续流程。
   *
   * 第二个参数是 `dropFirstBlankPage`：迷你包和整篇都受同一个「首段分页」影响，
   * 调用方在渲染迷你包时就要把它传下去，否则首屏第一眼仍然是那张空白页。
   *
   * 第三个参数是迷你包自身的统计（供首屏日志用）—— 此刻 `prepareDocx` 还没返回，
   * 调用方拿不到 `info`，只能这里带过去。
   */
  onMini?: (
    blob: Blob,
    dropFirstBlankPage: boolean,
    mini: { totalBlocks: number; usedBlocks: number; atSectionEnd: boolean }
  ) => Promise<void> | void;
}

/** 让出主线程一帧：长循环之间必须给事件循环留机会，否则界面按钮全部失灵。 */
const yieldToUI = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 0); });

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
  /** 样式自身声明的「段前分页」；undefined = 没声明（沿 basedOn 继承） */
  breakBefore?: boolean;
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
    map.set(idAttr[1], {
      basedOn: based ? based[1] : null,
      numId,
      breakBefore: styleBreakBefore(body, wp)
    });
  }
  return map;
}

/** ST_OnOff 语义：没有 val 属性 = true；0/false/off = false */
function onOff(tag: string, wp: string): boolean {
  const m = new RegExp(`${esc(wp)}:val="([^"]*)"`).exec(tag);
  if (!m) return true;
  const v = m[1].toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

/**
 * 取一段「样式定义 / 段落」里 pPr 直接声明的 pageBreakBefore。
 *
 * 只看 `<w:pPr>` 里，不看 rPr —— rPr 里也能出现同名元素（不成对地写在
 * 字符属性里），那跟分页毫无关系。
 */
function styleBreakBefore(seg: string, wp: string): boolean | undefined {
  const pPr = `${esc(wp)}:pPr`;
  const m = new RegExp(`<${pPr}\\b[^>]*>([\\s\\S]*?)</${pPr}>`).exec(seg);
  if (!m) return undefined;
  const tag = new RegExp(`<${esc(wp)}:pageBreakBefore\\b[^>]*>`).exec(m[1]);
  return tag ? onOff(tag[0], wp) : undefined;
}

/** 沿 basedOn 链找「最近一次明确声明」的段前分页（Word 的继承语义） */
function inheritedBreakBefore(styles: Map<string, StyleNum>, id: string): boolean {
  let cur: string | null = id;
  for (let i = 0; i < 12 && cur; i++) {
    const s = styles.get(cur);
    if (!s) return false;
    if (s.breakBefore != null) return s.breakBefore;
    cur = s.basedOn;
  }
  return false;
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
  // 收窄后的引用要单独拿出来：闭包里再访问 options.emfToPng 时，TS 不再认为它一定存在
  const emfToPng = options.emfToPng;

  const names = Object.keys(zip.files).filter((n) => /^word\/media\/[^/]+\.(emf|wmf)$/i.test(n));
  let done = 0;
  let next = 0;

  // 并发 4 路：每个元文件要走一趟「页面 → 宿主 GDI+ 光栅化 → 回传」的往返，
  // 30MB 手册里 70 个元文件串行要 7 秒多。宿主那边本来就是 fire-and-forget +
  // Task.Run，天然支持并行，所以这里一次发 4 个把等待叠起来（实测 7.5s → 3s 上下）。
  // 数量少时不必开线程池，直接按个数来。
  const workers = Math.max(1, Math.min(4, names.length));
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= names.length) return;
      const name = names[i];
      const f = zip.file(name);
      if (!f) continue;
      try {
        const b64 = await f.async('base64');
        const png64 = await emfToPng(b64);
        if (!png64) { failed++; }
        else {
          const bin = atob(png64);
          const bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          zip.file(name, bytes);
          exts.add(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
          ok++;
        }
      } catch {
        failed++;
      }
      // 进度按「已完成个数」报，与并发顺序无关；顺手让出一帧给事件循环，
      // 界面才不会整段僵住（关闭按钮/进度刷新都靠这个）。
      options.onProgress?.(++done, names.length);
      await yieldToUI();
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return { ok, failed, exts };
}

// ---------- ⑤ 首屏迷你包 ----------
//
// 【为什么需要】renderAsync 的耗时与 document.xml 的长度成正比：30MB 的手册
// 1228~2381ms，114MB 那份 5.2~8.7s，再叠上解包/转元文件/重打包，用户第一眼要等
// 十几秒 —— 原话是「打开需要40多秒，那我还不如直接用原始app打开」。
//
// 但只要先把 document.xml 截成「前若干个顶层块」，其余部件（styles / numbering /
// media / 页眉页脚）原样带上，docx-preview 就能在几百毫秒内产出**和整篇一模一样**的
// 第 1 页 —— 因为分页只看块高，而块高只取决于块自己的内容与列宽。
// 先用迷你包把第 1 页放出来，再在后台渲染整篇、原地换装。

const MINI_MAX_BYTES = 600_000;
const MINI_MAX_BLOCKS = 500;
/** 迷你包里的图片总量上限：超了就放弃迷你包（宁可慢，也不能把内存打爆） */
const MINI_MAX_MEDIA = 24 * 1024 * 1024;

/**
 * 找第一个 `<w:sectPr>` 元素，返回它的 [start, end)。
 *
 * 【为什么盯它】节属性（纸张尺寸 / 页边距 / 页眉页脚引用）决定"纸长什么样"。
 * 迷你包截断后必须把**第 1 节**的 sectPr 放在 body 末尾，否则会退回默认 A4 ——
 * 第 1 页的宽高就跟整篇不一样了，换装时缩放和页高双双跳变。
 */
function findSectPr(xml: string, wp: string, from = 0): { start: number; end: number } | null {
  const open = `<${wp}:sectPr`;
  let i = xml.indexOf(open, from);
  while (i >= 0) {
    const c = xml.charCodeAt(i + open.length);
    // 必须是标签名结束，避免命中 w:sectPrChange 之类
    if (c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13) {
      let j = i + open.length, quote = 0;
      for (; j < xml.length; j++) {
        const ch = xml.charCodeAt(j);
        if (quote) { if (ch === quote) quote = 0; continue; }
        if (ch === 34 || ch === 39) quote = ch;
        else if (ch === 62) break;
      }
      if (j >= xml.length) return null;
      if (xml.charCodeAt(j - 1) === 47) return { start: i, end: j + 1 };
      const close = `</${wp}:sectPr>`;
      const e = xml.indexOf(close, j + 1);
      if (e < 0) return null;
      return { start: i, end: e + close.length };
    }
    i = xml.indexOf(open, i + open.length);
  }
  return null;
}

/**
 * 数 <w:body> 的顶层子元素，并给出切点。
 *
 * 【只能在"一个顶层子元素刚结束"的位置切】切在标签中间直接产出非法 XML，
 * docx-preview 会整篇拒绝解析（退化成纯文本）。
 *
 * 两个切点候选，取**更早**的那个：
 *   ① 撞上块数/字节上限（迷你包别太大）；
 *   ② 承载 <w:sectPr> 的那个块**之后** —— 那一段属于第 1 节的正文，切掉它第 1 页就少内容
 *      （实测 114MB 那份的封面：少一段 = 少 113 个字 + 一张图，换装时肉眼可见）。
 *      它的 sectPr 同时被抄到 body 末尾当结尾节属性 —— 纸张尺寸/页边距/页眉页脚才跟整篇一致。
 *      （只取"更早"，是因为节很长时不得不在节内截断，这时也得靠这个 sectPr 定纸型。）
 */
function scanBody(
  xml: string, bodyStart: number, bodyEnd: number, sectAt: number,
  maxBlocks: number, maxBytes: number
): { cut: number; used: number; total: number; usedBlocks: number; atSectionEnd: boolean } | null {
  let depth = 0;
  let childStart = bodyStart;
  let total = 0;
  let capCut = -1, capBlocks = 0;
  let sectCut = -1, sectBlocks = 0;

  for (let i = bodyStart; i < bodyEnd; i++) {
    if (xml.charCodeAt(i) !== 60) continue;
    const c2 = xml.charCodeAt(i + 1);

    if (c2 === 33 /* ! */) {
      if (xml.startsWith('<!--', i)) { const j = xml.indexOf('-->', i + 4); if (j < 0) return null; i = j + 2; }
      else if (xml.startsWith('<![CDATA[', i)) { const j = xml.indexOf(']]>', i + 9); if (j < 0) return null; i = j + 2; }
      else { const j = xml.indexOf('>', i); if (j < 0) return null; i = j; }
      continue;
    }
    if (c2 === 63 /* ? */) { const j = xml.indexOf('?>', i + 2); if (j < 0) return null; i = j + 1; continue; }

    let j = i + 1, quote = 0;
    for (; j < bodyEnd; j++) {
      const ch = xml.charCodeAt(j);
      if (quote) { if (ch === quote) quote = 0; continue; }
      if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 62) break;
    }
    if (j >= bodyEnd) return null;

    const closing = c2 === 47 /* / */;
    const selfClose = xml.charCodeAt(j - 1) === 47;
    let childEnd = -1;

    if (closing) {
      depth--;
      if (depth === 0) childEnd = j + 1;
    } else if (!selfClose) {
      depth++;
    } else if (depth === 0) {
      childEnd = j + 1;                 // 顶层的自闭合块（w:bookmarkStart 之类）
    }

    if (childEnd > 0) {
      total++;
      if (capCut < 0 && (total >= maxBlocks || childEnd - bodyStart >= maxBytes)) {
        capCut = childEnd;
        capBlocks = total;
      }
      if (sectCut < 0 && sectAt >= childStart && sectAt < childEnd) {
        sectCut = childEnd;             // 含这一块：它是第 1 节的正文，不能丢
        sectBlocks = total;
      }
      childStart = childEnd;
    }
    i = j;
  }

  // 两个切点里取更早的；上限切点先到就切在上限处（节还没结束，纸型靠同一个 sectPr）
  const useCap = capCut > 0 && (sectCut < 0 || capCut <= sectCut);
  const cut = useCap ? capCut : sectCut;
  if (cut <= 0) return null;
  return {
    cut,
    used: cut - bodyStart,
    total,
    usedBlocks: useCap ? capBlocks : sectBlocks,
    // 没撞上限、正好切在 sectPr 那一块的末尾 ⇒ 第 1 节是完整的
    atSectionEnd: !useCap
  };
}

/** 用前若干个块拼一份迷你 document.xml；没有"后面还有内容"时返回 null。 */
function makeMiniXml(
  docXml: string, wp: string
): { xml: string; total: number; used: number; atSectionEnd: boolean } | null {
  const bodyOpen = docXml.indexOf(`<${wp}:body`);
  if (bodyOpen < 0) return null;
  const gt = docXml.indexOf('>', bodyOpen);
  if (gt < 0 || docXml.charCodeAt(gt - 1) === 47) return null;   // <w:body/> 空文档
  const bodyStart = gt + 1;
  const bodyClose = docXml.indexOf(`</${wp}:body>`, bodyStart);
  if (bodyClose < 0) return null;

  const sect = findSectPr(docXml, wp, bodyStart);
  if (!sect) return null;

  const r = scanBody(docXml, bodyStart, bodyClose, sect.start, MINI_MAX_BLOCKS, MINI_MAX_BYTES);
  if (!r) return null;
  // 截完只剩两三个块，没什么可省的，别折腾（这类文档本来也就几百毫秒）
  if (r.total - r.usedBlocks < 3) return null;

  const xml = docXml.slice(0, bodyStart)
    + docXml.slice(bodyStart, r.cut)
    + docXml.slice(sect.start, sect.end)
    + docXml.slice(bodyClose);
  return { xml, total: r.total, used: r.usedBlocks, atSectionEnd: r.atSectionEnd };
}

/** `word/media/../x.png` 这类相对路径规范化成 zip 里的条目名 */
function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1).replace(/\\/g, '/');
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  const out: string[] = [];
  for (const seg of `${dir}/${target}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

const RID_IN_XML = /\br:(?:embed|link|id|pict|dm|lo|qs|cs)="([^"]+)"/g;

/**
 * 打一个只含前几页的迷你 docx。
 *
 * 部件取舍：除 `word/media`、`word/embeddings`、`word/fonts`、`customXml` 以外**全带上**
 * （styles / numbering / settings / fontTable / theme / 页眉页脚都是小文件，
 * 而且少一个就可能让排版变样）；图片只带迷你包里真正引用到的那几张，
 * 否则 114MB 那份的手册光图像就有 100MB，迷你包等于整包。
 */
async function buildMiniPackage(zip: JSZip, miniXml: string, wp: string): Promise<Blob | null> {
  const out = new JSZip();
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

  const kept: string[] = [];
  for (const name of names) {
    if (name === 'word/document.xml') continue;
    if (/^(word\/media|word\/embeddings|word\/fonts|customXml)\//i.test(name)) continue;
    kept.push(name);
  }

  // 各部件自己的 rels：rId → zip 条目名
  const cache = new Map<string, Map<string, string>>();
  async function relsOf(part: string): Promise<Map<string, string>> {
    const hit = cache.get(part);
    if (hit) return hit;
    const m = new Map<string, string>();
    const f = zip.file(`${resolveTarget(part, `_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`)}`);
    if (f) {
      const s = await f.async('string');
      for (const t of s.matchAll(/<Relationship\b[^>]*>/g)) {
        const tag = t[0];
        if (/\bTargetMode\s*=\s*"External"/i.test(tag)) continue;
        const id = /\bId\s*=\s*"([^"]*)"/.exec(tag)?.[1];
        const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1];
        if (id && target) m.set(id, resolveTarget(part, target));
      }
    }
    cache.set(part, m);
    return m;
  }

  // 只在这些部件里找图片引用：正文 + 页眉页脚 + 脚注（styles 动辄几 MB，不扫）
  const scanParts = kept.filter((n) => /^word\/(header|footer|footnotes|endnotes)[^/]*\.xml$/i.test(n));
  const media = new Set<string>();
  let budget = MINI_MAX_MEDIA;

  const hunt = async (part: string, text: string | null): Promise<boolean> => {
    const xml = text ?? await zip.file(part)?.async('string');
    if (!xml) return true;
    const rels = await relsOf(part);
    for (const m of xml.matchAll(RID_IN_XML)) {
      const target = rels.get(m[1]);
      if (!target || media.has(target)) continue;
      const f = zip.file(target);
      if (!f) continue;
      const size = ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize) || 0;
      budget -= size;
      if (budget < 0) return false;
      media.add(target);
    }
    return true;
  };

  if (!await hunt('word/document.xml', miniXml)) return null;
  for (const part of scanParts) {
    if (!await hunt(part, null)) return null;
  }

  out.file('word/document.xml', miniXml);
  for (const name of kept) {
    const f = zip.file(name);
    if (f) out.file(name, await f.async('uint8array'));
  }
  for (const name of media) {
    const f = zip.file(name);
    if (f) out.file(name, await f.async('uint8array'));
  }

  try {
    return await out.generateAsync({ type: 'blob', compression: 'STORE' });
  } catch {
    return null;
  }
}

// ---------- 入口 ----------

/**
 * 正文**第一个段落**是否带「段前分页」。
 *
 * 【为什么必须专门处理】Word 会忽略「文档最开头那一段」的段前分页 —— 前面没有内容，
 * 分了也分不出新页。docx-preview 不会：`splitBySection` 一遇到 pageBreakBefore 就把
 * 当前页直接切出去，而当前页此刻还是空的，于是正文第一页变成一张只有页眉页脚的白纸。
 *
 * 实测样本：封面第一段套了「目录标题1」样式，该样式 basedOn heading 1，heading 1 带
 * `<w:pageBreakBefore/>`。Word 打开正常（封面就是第 1 页），预览却先给一张空白页。
 *
 * 返回 true = 渲染结果里第 1 个 section 会是这张假空白页，调用方应当把它丢掉。
 * 段落自己带硬分页符（`<w:br w:type="page"/>`）或自带 sectPr 的，Word 里也确实是空页，
 * 一律返回 false 交给正常流程。
 */
function firstParaBreakBefore(
  docXml: string, styles: Map<string, StyleNum>, wp: string
): boolean {
  const bodyM = new RegExp(`<${esc(wp)}:body\\b[^>]*>`).exec(docXml);
  if (!bodyM) return false;
  const stopTag = `</${esc(wp)}:body>`;
  const endIdx = docXml.search(new RegExp(stopTag));
  const stop = endIdx > 0 ? endIdx : docXml.length;
  let i = bodyM.index + bodyM[0].length;

  for (;;) {
    while (i < stop && /\s/.test(docXml[i])) i++;
    if (docXml.startsWith('<!--', i)) {
      const c = docXml.indexOf('-->', i);
      i = c < 0 ? stop : c + 3;
      continue;
    }
    break;
  }
  if (i >= stop || !docXml.startsWith(`<${esc(wp)}:p`, i)) return false;
  // `<w:p>` / `<w:p `；排除 `<w:pPr>` 之类的同前缀标签
  const nextCh = docXml[i + wp.length + 3];
  if (nextCh !== '>' && !/\s/.test(nextCh || '')) return false;
  const gt = docXml.indexOf('>', i);
  if (gt < 0) return false;
  if (docXml[gt - 1] === '/') return false;

  const closeTag = `</${esc(wp)}:p>`;
  const closeIdx = docXml.search(new RegExp(closeTag));
  const segEnd = closeIdx > 0 && closeIdx > gt ? closeIdx + `</${wp}:p>`.length : stop;
  const seg = docXml.slice(i, segEnd);

  if (new RegExp(`<${esc(wp)}:br\\b[^>]*${esc(wp)}:type="page"`).test(seg)) return false;
  if (new RegExp(`<${esc(wp)}:sectPr\\b`).test(seg)) return false;

  const own = styleBreakBefore(seg, wp);
  if (own != null) return own;

  const pPr = new RegExp(`<${esc(wp)}:pPr\\b[^>]*>([\\s\\S]*?)</${esc(wp)}:pPr>`).exec(seg);
  if (!pPr) return false;
  const st = new RegExp(`<${esc(wp)}:pStyle\\b[^>]*${esc(wp)}:val="([^"]*)"`).exec(pPr[1]);
  if (!st) return false;
  return inheritedBreakBefore(styles, st[1]);
}

/**
 * 返回预处理结果。
 *
 * - `null`：不是 docx / 解析失败 / document.xml 被我们改坏 —— 调用方用原数据直接渲染。
 * - `data === null`：整篇不需要任何修改（也就没有必要重打包），但 `info` 里可能带了迷你包。
 */
export async function prepareDocx(
  ab: ArrayBuffer, options: DocxPrepOptions = {}
): Promise<{ data: Blob | null; info: DocxPrepInfo } | null> {
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
  const tX = Date.now();

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

  const tHf = Date.now();

  // ② numId=0（显式不要编号）
  let numCleared = 0;
  let styles: Map<string, StyleNum> = new Map();
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    const stylesXml = await stylesFile.async('string');
    styles = indexStyles(stylesXml, wp);
    const r = clearDisabledNumbering(xml, styles, wp);
    if (r.fixed) {
      xml = r.xml;
      numCleared = r.fixed;
      changed = true;
    }
  }

  const tNum = Date.now();

  // ③ 页眉页脚部件里的页码域
  let fields = 0;
  const broken: string[] = [];
  const parts = Object.keys(zip.files).filter((n) => /^word\/(header|footer)[^/]*\.xml$/i.test(n));
  for (const name of parts) {
    const f = zip.file(name);
    if (!f) continue;
    const src = await f.async('string');
    const r = markPageFields(src, wp);
    if (!r.fields) continue;
    // 改坏了就放弃这一份：一个页脚的页码域，不值得让整篇文档降级成纯文本
    if (!xmlOkAny(r.xml)) { broken.push(name); continue; }
    zip.file(name, r.xml);
    fields += r.fields;
    changed = true;
  }

  const tC = Date.now();

  // ④ 元文件转换（要等宿主回话，放在最后做，前面的纯字符串活先干完）
  const emf = await convertMetafiles(zip, options);
  const tEmf = Date.now();
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

  // document.xml 是命根子：它要是被改坏，docx-preview 会整篇拒绝解析、退化成纯文本。
  // 与其降级，不如原样交出去（只是少了继承/编号/页码这几项修饰）。
  const tCheck0 = Date.now();
  const okDoc = xmlOkAny(docXml);
  const tCheck = Date.now() - tCheck0;
  if (!okDoc) return null;

  // ===== 首屏迷你包 =====
  // 刻意排在重打包之前：重打包（30MB 那份 2.6s、114MB 那份 543ms）与迷你渲染
  // 没有先后依赖，先把首屏交出去，那几百毫秒到两秒的打包时间就藏在用户已经能读的页后面了。
  const dropFirstBlankPage = firstParaBreakBefore(docXml, styles, wp);
  const tM0 = Date.now();
  let mini: DocxPrepInfo['mini'];
  const cut = makeMiniXml(docXml, wp);
  if (cut) {
    const blob = await buildMiniPackage(zip, cut.xml, wp);
    if (blob) {
      mini = {
        data: blob,
        totalBlocks: cut.total,
        usedBlocks: cut.used,
        atSectionEnd: cut.atSectionEnd
      };
      if (options.onMini) {
        try {
          await options.onMini(blob, dropFirstBlankPage, {
            totalBlocks: cut.total, usedBlocks: cut.used, atSectionEnd: cut.atSectionEnd
          });
        } catch { /* 首屏失败不影响整篇 */ }
      }
    }
  }
  const miniMs = Date.now() - tM0;

  const baseInfo: DocxPrepInfo = {
    inherited, blankFirst, sections, numCleared, fields,
    emf: emf.ok, emfFailed: emf.failed,
    broken: broken.length ? broken : undefined,
    dropFirstBlankPage,
    mini
  };

  if (!changed) {
    // 整篇不需要任何修改 ⇒ 不必重打包（省一笔），调用方拿原数据渲染整篇
    return {
      data: null,
      info: {
        ...baseInfo,
        ms: {
          load: tB - tA, xml: tX - tB, hf: tHf - tX, num: tNum - tHf,
          fields: tC - tNum, emf: tEmf - tC, check: tCheck, mini: miniMs, zip: 0
        }
      }
    };
  }

  zip.file('word/document.xml', docXml);

  const tD = Date.now();
  // 【v1.9.6】这个包只在内存里喂给 docx-preview，随即被它整个解压回来，
  // 压缩没有任何收益：图片/字体本身就是压缩格式，DEFLATE level 1 一个字节也省不下，
  // 却要把解压后的全部内容（30MB 的手册约 83MB）整个过一遍压缩器 ——
  // 实测单这一步就 2.6 秒。改成 STORE（只打包不压缩）：CPU 从压缩降到拷贝+CRC。
  //
  // 【v1.12 修】这里原来对 >64MB 的文档切回 DEFLATE，理由是"STORE 会让内存里
  // 同时存在解压后的内容与等大的包"。实测 214MB 那份手册（205MB 全是图片）：
  // 这一步 **15.0 秒**，而产出的包只比 STORE 小 8MB —— 图片本身已经是压缩格式，
  // 重压一遍纯粹是在 205MB 数据上白跑压缩器。真正会撑爆内存的是"整篇读进来 +
  // 整篇重打包 + 一次渲染上千张图"，不是 STORE 与否。
  // 现在一律 STORE。宿主侧 MaxFullBody = 256MB，整篇读取本来就到不了更大的体量；
  // 万一将来放开，STORE 的输出 = 解压后总和，那时再退回压缩也来得及。
  const compress: 'STORE' | 'DEFLATE' = ab.byteLength >= 512 * 1024 * 1024 ? 'DEFLATE' : 'STORE';
  const data = await zip.generateAsync({
    type: 'blob', compression: compress, compressionOptions: { level: 1 }
  });
  const tE = Date.now();
  return {
    data,
    info: {
      ...baseInfo,
      ms: {
        load: tB - tA,
        xml: tX - tB,
        hf: tHf - tX,
        num: tNum - tHf,
        fields: tC - tNum,
        emf: tEmf - tC,
        check: tCheck,
        mini: miniMs,
        zip: tE - tD
      }
    }
  };
}
