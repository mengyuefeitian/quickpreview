// Word（docx）预览：单页 / 双页浏览 + 缩放
//
// docx-preview 会把文档按 Word 的分页符切成多个 <section class="docx-preview">，
// 外面再套一层 <div class="docx-preview-wrapper">，默认是「全部纵向堆叠」。
// 这里把它改造成和 PDF 一致的阅读器：
//   · 单页：一次只显示一页，左右键 / 滚轮翻页（与 PDF 手感一致）
//   · 双页：两页并排
//   · 缩放：底部控件，默认「适应窗口」
//
// 缩放用 CSS `zoom`（Chromium 支持，会真正重排、文字保持清晰），
// 而不是 transform: scale（后者会留白且文字发虚）。
import { postToHost } from './host';
import { mountZoomControl } from './zoom';
import type { Pager } from './pdfview';
import type { SectionFixResult } from './docxsec';

export interface DocxViewerOptions {
  name: string;
  stale: () => boolean;
  onBoundary?: (dir: 1 | -1) => void;
}

// 与 PDF 一致：单页/双页、缩放都跨文件保持
let spreadPref = false;
let zoomPref = 0;

const PAGE_GAP = 14;
// 必须和 style.css 里 .docx-stage 的 padding 保持一致（18px 24px）
const STAGE_PAD_X = 24;
const STAGE_PAD_Y = 18;
const MAX_PAGES_IN_DOM = 400;   // 超过这个页数直接全量堆叠（分页切换反而更慢）

// 【坑】docx-preview 的制表位宽度不是渲染时算的，而是 `refreshTabStops()` 里
// `setTimeout(…, 500)` 延时回填 style（因为要先有真实布局才能量出位置）。
// renderAsync 的 Promise 在 500ms 之前就 resolve 了，此时 tab span 上还没有
// `text-decoration: underline dotted` / `word-spacing`，据此判断目录会全部漏掉
// （实测 36 个 tab 全被当成普通制表位跳过，目录仍旧折行）。
async function waitTabStopsReady(root: HTMLElement): Promise<void> {
  const hasAny = root.querySelector('.docx-preview-tab-stop');
  if (!hasAny) return;                 // 没有制表符的文档不用等
  const t0 = Date.now();
  while (Date.now() - t0 < 900) {
    const tabs = Array.from(root.querySelectorAll('.docx-preview-tab-stop'));
    if (tabs.some((t) => /dotted|word-spacing/i.test(t.getAttribute('style') || ''))) return;
    await new Promise((r) => setTimeout(r, 40));
  }
}

// docx-preview 把 <w:tab/> 模拟成「一个带巨大 word-spacing 的空格」：
//   <span class="docx-preview-tab-stop" style="text-decoration: underline dotted;
//                                            word-spacing: 415pt;">&nbsp;</span>
// 目录（TOC）用的是「右对齐 + 点线引导符」的制表位，位置常在 8306 twips（415pt = 553px），
// 比整行可用宽度还大 ⇒ 标题被挤成两三行（"1 概" / "述" / "7"），点线也只剩一个字符宽。
// 这里把它改造成等价于 Word 的三段式布局：[标题] [点线填充] [页码]。
function fixTocTabs(root: HTMLElement): { fixed: number; seen: number } {
  const tabs = Array.from(root.querySelectorAll('.docx-preview-tab-stop')) as HTMLElement[];
  let fixed = 0;

  // 同一段落里可能有多个制表位（序号后的对齐位 + 页码前的点线位），
  // 优先取点线那个；没有点线就取超出半个页面的那个；都不到，但段落本身是
  // 目录样式（docx-preview 按 w:pStyle 生成的 docx-preview_toc1/2/3），
  // 就取最后一个 —— 一级目录条目的制表位常常只有十几 pt，不符合前两条判据。
  const pickSep = (p: HTMLElement): HTMLElement | null => {
    const own = Array.from(p.querySelectorAll('.docx-preview-tab-stop')) as HTMLElement[];
    const width = p.getBoundingClientRect().width || 0;
    const ptOf = (el: HTMLElement): number => {
      const m = /word-spacing:\s*([\d.]+)pt/.exec(el.getAttribute('style') || '');
      return m ? parseFloat(m[1]) : 0;
    };
    const dotted = own.find((t) => /dotted/i.test(t.getAttribute('style') || ''));
    if (dotted) return dotted;
    const wide = own.find((t) => ptOf(t) * (96 / 72) > width * 0.5);
    if (wide) return wide;
    if (/docx-preview[-_]toc\d/i.test(p.className) && own.length) return own[own.length - 1];
    return null;
  };

  const seen = new Set<HTMLElement>();
  for (const tab of tabs) {
    const p = tab.closest('p') as HTMLElement | null;
    if (!p || seen.has(p) || p.classList.contains('qp-toc-item')) continue;
    const sepTab = pickSep(p);
    if (!sepTab) continue;
    seen.add(p);

    // tab 外面通常还套着一层 <span>（docx-preview 的包装），一起当成"分隔点"
    let sep: HTMLElement = sepTab;
    while (
      sep.parentElement && sep.parentElement !== p &&
      sep.parentElement.tagName === 'SPAN' &&
      sep.parentElement.childElementCount === 1
    ) sep = sep.parentElement;

    // 【坑】带书签的目录条目整行包在 <a>（w:hyperlink）里，分隔点根本不在 p 的直接子级：
    // 只按「p 的子级」切分时循环永远等不到 sep，于是整行（含点线制表位）都被塞进 head，
    // head 撑到 500px 后标题折成两行、点线宽度归零 —— 目录页因此比 A4 高出 300 多像素。
    // 这里以「分隔点的父级」为切分容器，两侧内容分别搬到 head / num。
    const host = (sep.parentElement && sep.parentElement !== p ? sep.parentElement : p) as HTMLElement;
    const link = host.tagName === 'A' ? (host.cloneNode(false) as HTMLElement) : null;

    const head = document.createElement('span');
    head.className = 'qp-toc-head';
    // flex 容器上 text-indent 不生效，目录的层级缩进（首行缩进）要搬到 head 上，
    // 否则二三级条目会全部顶格，看起来"目录层级没了"。
    const indent = parseFloat(getComputedStyle(p).textIndent) || 0;
    if (indent > 0) head.style.paddingLeft = `${indent}px`;

    const num = document.createElement('span');
    num.className = 'qp-toc-num';

    if (host === p) {
      while (p.firstChild && p.firstChild !== sep) head.appendChild(p.firstChild);
    } else {
      while (p.firstChild && p.firstChild !== host) head.appendChild(p.firstChild);
      while (host.firstChild && host.firstChild !== sep) head.appendChild(host.firstChild);
    }
    sep.remove();

    if (host !== p) {
      while (host.firstChild) num.appendChild(host.firstChild);
      let node = host.nextSibling;
      while (node) {
        const next = node.nextSibling;
        num.appendChild(node);
        node = next;
      }
      host.remove();          // 内容已搬空；原来的 <a> 用 link 重新包住标题
    } else {
      while (p.firstChild) num.appendChild(p.firstChild);
    }

    const leader = document.createElement('span');
    leader.className = 'qp-toc-leader';

    p.textContent = '';
    if (link) {
      link.appendChild(head);
      p.appendChild(link);
    } else {
      p.appendChild(head);
    }
    p.appendChild(leader);
    p.appendChild(num);
    p.classList.add('qp-toc-item');
    fixed++;
  }
  return { fixed, seen: tabs.length };
}

// docx-preview 对「浮动」元素有两种半成品渲染，都会把版面挤坏：
//
// ① 浮动图片（wp:anchor）：外层是个 width/height 都是 0 的 inline-block，图片本身
//    position:relative。壳子并没有把图片真正摘出文档流 —— 实测封面上一张 602×285pt 的
//    版式图仍把段落撑出 384px，整页比 A4 多 181px，于是被分页逻辑切成两页
//    （表现就是「封面底部信息跑到第 2 页」）。
//
// ② 文本框（wps:txbx，docx-preview 走的是 mc:Fallback 的 VML 分支）：它把 VML 的 style
//    原样搬过来 —— position:absolute;left:0;margin-left:-28.5pt;margin-top:54.85pt。
//    绝对定位让它脱离文档流跑到页面左上角，段落却一点没变高 ⇒ 后面的"创建时间/公司网址"
//    整块顶上来，压在封面大标题上，看起来就是「文字层叠乱码」。
//    （Word 里这个框是 wrapSquare，会把正文推开。）
//
// 统一处理：改成绝对定位（坐标按 OOXML 语义算），并记住它相对「锚点段落」的偏移。
// 偏移必须相对段落、不能相对纸张：后面 paginate 会把段落搬到别的页，纸张坐标随即失效。
// 绕排（mso-wrap-style:square/tight）的文本框还要让段落把这块高度让出来。
interface AnchorRec { el: HTMLElement; p: HTMLElement; dx: number; dy: number }

const PT2PX = 96 / 72;

function styleNum(style: string, name: string): number | null {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(-?[\\d.]+)\\s*(pt|px|cm|mm)?`, 'i').exec(style);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const unit = m[2] || 'px';
  return unit === 'pt' ? n * PT2PX
    : unit === 'cm' ? n * 96 / 2.54
      : unit === 'mm' ? n * 96 / 25.4 : n;
}

const anchors: AnchorRec[] = [];

function collectAnchors(root: HTMLElement): { floats: number; boxes: number; reserved: number } {
  const secs = Array.from(root.querySelectorAll('section')) as HTMLElement[];
  let floats = 0, boxes = 0, reserved = 0;
  anchors.length = 0;      // 同一会话里连续预览多个文档，旧记录要丢掉

  const push = (el: HTMLElement, p: HTMLElement, dx: number, dy: number): void => {
    anchors.push({ el, p, dx, dy });
  };

  for (const sec of secs) {
    // ① 浮动图片：0×0 的壳里包着 img，壳还在文档流里
    const wrappers = (Array.from(sec.querySelectorAll('div')) as HTMLElement[]).filter((d) => {
      if (d.style.position === 'absolute') return false;
      const s = (d.getAttribute('style') || '').replace(/\s+/g, '');
      return s.includes('width:0') && s.includes('height:0') && !!d.querySelector('img');
    });
    for (const w of wrappers) {
      const img = w.querySelector('img') as HTMLElement;
      const p = w.closest('p') as HTMLElement | null;
      if (!img || !p) continue;
      const ir = img.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      w.style.position = 'absolute';
      push(w, p, ir.left - pr.left, ir.top - pr.top);
      floats++;
    }

    // ② 绝对定位的文本框（docx-preview 渲染成 svg + foreignObject）。
    // 只用 foreignObject 认文本框：VML 水印/图形也是 position:absolute 的 svg，
    // 它们的坐标本来是对的，动它们反而会把水印挪位。
    const svgs = (Array.from(sec.querySelectorAll('svg')) as unknown as HTMLElement[]).filter((s) =>
      /position\s*:\s*absolute/i.test(s.getAttribute('style') || '') && !!s.querySelector('foreignObject'));
    for (const svg of svgs) {
      const p = svg.closest('p') as HTMLElement | null;
      if (!p) continue;
      const st = svg.getAttribute('style') || '';
      // VML 的定位语义：left = 文字栏左边界 + margin-left；top = 锚点段落顶 + margin-top
      const dx = styleNum(st, 'margin-left') ?? 0;
      const dy = styleNum(st, 'margin-top') ?? 0;
      const w = svg.offsetWidth || styleNum(st, 'width') || 0;
      const h = svg.offsetHeight || styleNum(st, 'height') || 0;
      svg.style.marginLeft = '0';
      svg.style.marginTop = '0';
      push(svg, p, dx, dy);
      boxes++;

      // 四周绕排的框会推开正文：把锚点段落撑到「框顶偏移 + 框高」
      const wrap = /mso-wrap-style\s*:\s*(\w+)/i.exec(st);
      const wrapStyle = (wrap ? wrap[1] : '').toLowerCase();
      if (h > 0 && (wrapStyle === 'square' || wrapStyle === 'tight')) {
        const need = Math.round(dy + h);
        if (need > p.offsetHeight) {
          p.style.minHeight = `${need}px`;
          reserved++;
        }
      }
    }
  }
  return { floats, boxes, reserved };
}

// 分页完成后（段落可能被搬到别的页）重算所有绝对定位元素的坐标。
// 必须在写 style.zoom 之前调用，否则量到的差值已经被缩放放大过。
function applyAnchors(): void {
  for (const a of anchors) {
    const sec = a.p.closest('section') as HTMLElement | null;
    if (!sec) continue;
    sec.style.position = 'relative';
    const pr = a.p.getBoundingClientRect();
    const sr = sec.getBoundingClientRect();
    a.el.style.position = 'absolute';
    a.el.style.left = `${Math.round(pr.left - sr.left + a.dx)}px`;
    a.el.style.top = `${Math.round(pr.top - sr.top + a.dy)}px`;
  }
}


// docx-preview 只在 w:pageBreakBefore / w:lastRenderedPageBreak 处切页。
// 很多文档（WPS、第三方工具导出、被"清理"过的 Word 文件）两者都没有，
// 于是只能切出寥寥几节，一节里塞进好几页内容 —— 表现为：
//   · 页面高低不一（内容多的页被撑高，和 Word 里清一色 A4 的观感完全不同）
//   · 「适应窗口」按整页算，把页面压到 25%，字小到看不清
//   · 一页要滚两三屏才翻得动，滚轮手感很黏
// 这里把装不下的节按「内容区高度」重新切开，切点只落在段落 / 表格边界。
//
// 【关键】可用高度必须用「内容区」（纸张高 − 上下页边距），不能用整页高度：
// docx-preview 把纸张尺寸写成 section 的 inline `width/min-height`，页边距写成 `padding`，
// A4 上下各 72pt ⇒ 1122.5px 的纸只有 930px 能放正文。
// 之前拿「1.02 倍纸高」当阈值，等于每页硬塞进 20% 多余的内容，
// 结果页页溢出、页页被撑高（实测封面 1303px、正文 1122px，高低不齐）。
type PageBox = { pageH: number; padT: number; padB: number; inner: number };

function pageBox(sec: HTMLElement): PageBox {
  const cs = getComputedStyle(sec);
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  // min-height 就是 docx-preview 从 sectPr 写进来的纸张高度（A4 = 841.9pt = 1122.5px）
  const pageH = parseFloat(cs.minHeight) || sec.offsetHeight || 1122.5;
  return { pageH, padT, padB, inner: Math.max(120, pageH - padT - padB) };
}

/** 量一个块的实际占用高度（含上下外边距）。 */
function blockHeight(k: HTMLElement): number {
  const cs = getComputedStyle(k);
  return k.getBoundingClientRect().height
    + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
}

// 一张表如果本身就超过一页，整块塞进一页会被撑成"长页"（用户看到的：
// 表格没按 A4 断开，页面被拉得老长，翻页手感全乱）。
// Word 的做法是在行边界处断开、续页接着排版，所以这里把表按行拆成几张，
// 交给正常的分页逻辑去分配。
//
// 首段沿用原表元素（样式/边框/宽度原封不动），后续段克隆空壳 + colgroup ——
// 不复制列宽的话，续页的列会退化成自动分配，和首页对不齐。
// 导出仅供 test-samples/dev_docx_table_test.py 单元验证（生产入口不引用，会被 tree-shake 掉）
export function splitTableByRows(
  table: HTMLTableElement, firstLimit: number, restLimit: number = firstLimit
): HTMLElement[] {
  const thead = table.tHead;
  // 表头行单独处理：它要复制到每一段，不能当成普通数据行搬来搬去
  const bodyRows = (Array.from(table.rows) as HTMLElement[])
    .filter((r) => !thead || r.parentElement !== thead);
  if (bodyRows.length < 2) return [table];

  const colgroup = table.querySelector(':scope > colgroup') as HTMLElement | null;
  const heights = bodyRows.map((r) => r.getBoundingClientRect().height);

  for (const r of bodyRows) r.remove();

  const parts: HTMLElement[] = [table];
  let cur: HTMLElement = table;
  let acc = 0;
  // 第一段只占「当前页剩余空间」，其后各段占满整页 —— 否则表格前面有标题/段落时，
  // 第一段按整页高拆会放不下，只能整段换页，把上一页空掉大半。
  let limit = firstLimit;
  for (let i = 0; i < bodyRows.length; i++) {
    // acc === 0 说明这一段刚开，单行再高也得放（否则会左右横跳、反复建表）
    if (acc > 0 && acc + heights[i] > limit) {
      const t = table.cloneNode(false) as HTMLTableElement;
      t.removeAttribute('id');
      if (colgroup) t.appendChild(colgroup.cloneNode(true));
      if (thead) t.appendChild(thead.cloneNode(true));
      cur.after(t);
      parts.push(t);
      cur = t;
      acc = 0;
      limit = restLimit;
    }
    cur.appendChild(bodyRows[i]);
    acc += heights[i];
  }
  return parts;
}

// 把一节的内容按 limit（内容区高度）切成若干页，返回新建的页（按原顺序）
export function cutSection(sec: HTMLElement, limit: number): HTMLElement[] {
  const art = sec.querySelector(':scope > article') as HTMLElement | null;
  if (!art) return [];
  const kids = Array.from(art.children) as HTMLElement[];
  if (!kids.length) return [];

  const head = sec.querySelector(':scope > header');
  const foot = sec.querySelector(':scope > footer');
  const made: HTMLElement[] = [];
  let curArt = art;
  let acc = 0;

  const newPage = (): void => {
    const ns = sec.cloneNode(false) as HTMLElement;   // 只复制标签 + class + style（纸张尺寸在 style 里）
    ns.removeAttribute('id');
    if (head) ns.appendChild(head.cloneNode(true));   // 页眉页脚是绝对定位在 section 里的
    const na = document.createElement('article');
    ns.appendChild(na);
    if (foot) ns.appendChild(foot.cloneNode(true));
    (made.length ? made[made.length - 1] : sec).after(ns);
    made.push(ns);
    curArt = na;
    acc = 0;
  };

  // 一次性量完（含上下外边距），避免边搬边测反复重排。
  // 队列会在拆表时就地插入新段，所以量好的高度也同步用数组维护。
  const queue = kids.slice();
  const qh = kids.map(blockHeight);

  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    let kh = qh[i];

    // 「单块就超过一页」的表格：按行拆开再分配。
    // 不拆的话 acc === 0 不会切，整张表只能塞在同一页 ⇒ 页面被撑成长页。
    if (k.tagName === 'TABLE' && kh > limit) {
      // 本页剩余空间不足三成时不要硬拆：那只拆得出两三行，
      // 这几行在新页上独占一整页，比留白还浪费。整表挪到新页再按整页拆。
      if (acc > 0 && limit - acc < limit * 0.3) newPage();
      const room = acc > 0 ? limit - acc : limit;
      const parts = splitTableByRows(k as HTMLTableElement, room, limit);
      if (parts.length > 1) {
        const hs = parts.map(blockHeight);
        queue.splice(i, 1, ...parts);   // parts[0] 就是 k 本身，留在队列同一位置
        qh.splice(i, 1, ...hs);
        kh = hs[0];
      }
    }

    // 当前页已装了内容、再加这一段就溢出 ⇒ 另起一页。
    // acc === 0 时不切：单个段落本身就超过一页的话，硬塞到新页只会留个空页。
    if (acc > 0 && acc + kh > limit) newPage();
    curArt.appendChild(queue[i]);
    acc += kh;
  }
  return made;
}

// 反复切，直到这一页不再溢出（或切不动 / 轮次用完）。
// 第二轮起按「真实溢出比例」收缩可用高度：外边距折叠、分页后段落重新排布
// 都会让第一次的估算偏乐观，光靠一次切分常有几页仍然高出几十像素。
function paginate(sec: HTMLElement, depth = 0): HTMLElement[] {
  const box = pageBox(sec);
  const over = sec.offsetHeight - box.pageH;
  if (over <= 2 || depth >= 4) return [sec];

  const actual = Math.max(1, sec.offsetHeight - box.padT - box.padB);
  const limit = depth === 0
    ? box.inner
    : Math.max(80, Math.floor((box.inner * box.inner) / actual * 0.99));

  const made = cutSection(sec, limit);
  if (!made.length) return [sec];

  const out: HTMLElement[] = [sec];
  for (const p of made) out.push(...paginate(p, depth + 1));
  return out;
}

function splitOversizePages(pages: HTMLElement[]): { from: number; to: number; split: number } {
  let total = 0;
  let split = 0;
  for (const sec of pages) {
    const out = paginate(sec);
    total += out.length;
    if (out.length > 1) split++;
  }
  return { from: pages.length, to: total, split };
}

// 分页后各页应当等高（= 纸张高度）。日志里带上最高/最矮两页，
// 回归时一眼就能看出"高低不齐"（有页面被内容撑高）。
function pageSpan(pages: HTMLElement[]): string {
  let lo = Infinity;
  let hi = 0;
  for (const p of pages) {
    const h = p.offsetHeight;
    if (!h) continue;
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  if (lo === Infinity) return '';
  return `，页高 ${lo}${hi - lo > 2 ? `~${hi}（不齐 ${hi - lo}px）` : ''}px`;
}

export async function renderDocxViewer(
  ab: ArrayBuffer, body: HTMLElement, bar: HTMLElement, opts: DocxViewerOptions
): Promise<Pager | null> {
  const stale = opts.stale;

  const { renderAsync } = await import('docx-preview');
  if (stale()) return null;

  // 页眉页脚按 OOXML 的「节内没写就继承上一节」补齐引用；
  // 不补的话 docx-preview 只给第一节渲染页眉页脚，后面几十页全是光板。
  // titlePg（首页不同）也在这里修 —— docx-preview 首页取不到 first 引用时会退回 default，
  // 于是封面被硬塞上正文页眉页脚。
  let input: ArrayBuffer | Blob = ab;
  let secInfo: SectionFixResult | null = null;
  let preMs = 0;
  const preStart = Date.now();
  try {
    const { fixSectionHeaderFooter } = await import('./docxsec');
    const fixed = await fixSectionHeaderFooter(ab);
    preMs = Date.now() - preStart;
    if (fixed) {
      input = fixed.data;
      secInfo = fixed.info;
    }
  } catch { /* 预处理失败不致命：按原样渲染，只是页眉页脚可能缺 */ }
  if (stale()) return null;

  // 离屏渲染：先让 docx-preview 完整产出，再取其中的页面元素重新编排
  const off = document.createElement('div');
  off.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px;';
  const styleHost = document.createElement('div');
  document.body.appendChild(off);
  document.body.appendChild(styleHost);

  try {
    await renderAsync(input, off, styleHost, {
      className: 'docx-preview',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      experimental: true,
      trimXmlDeclaration: true,
      debug: false
    });
  } catch (e) {
    off.remove();
    styleHost.remove();
    throw e;
  }
  if (stale()) { off.remove(); styleHost.remove(); return null; }

  // 【坑】docx-preview 的类名是从 options.className 派生的：
  //   wrapper 类名 = `${className}-wrapper`，页面是 `section.${className}`
  // 我们传的是 className:'docx-preview'，所以真实 DOM 是
  //   div.docx-preview-wrapper > section.docx-preview
  // 而不是官方 README 里常见的 .docx-wrapper / section.docx。
  // 之前按 .docx-wrapper / section.docx 查，querySelectorAll 返回 0 个，
  // pageCount 兜底成 1、singlePageMode=false、paintPages 直接 return，
  // 页面元素虽在 DOM 里但样式与显示逻辑全部落空 —— 表现就是"整页空白"。
  const wrapper = (off.querySelector('.docx-preview-wrapper')
    || off.querySelector('[class$="-wrapper"]')) as HTMLElement | null;

  // 目录（TOC）制表位修正：必须在量页面尺寸之前做完，
  // 否则被撑高的目录页会让 naturalH 严重偏大，把「适应窗口」压到 25% 之类，字小到看不清。
  await waitTabStopsReady(wrapper || off);
  if (stale()) { off.remove(); styleHost.remove(); return null; }
  const tocFixed = fixTocTabs(wrapper || off);

  // 浮动图片 / 文本框先摘出文档流，否则它们占的高度会让整页虚高、被误判成"超长页"切开；
  // 绕排文本框还要把段落撑高，后面的正文才不会顶进框里。
  const anchorInfo = collectAnchors(wrapper || off);

  // 超长页按段落边界重新分页（目录修正之后做：目录折行会把页撑高好几倍）
  const pickPages = (): HTMLElement[] => (wrapper
    ? Array.from(wrapper.querySelectorAll(':scope > section'))
    : Array.from(off.querySelectorAll('section'))) as HTMLElement[];
  let pages = pickPages();
  const splitInfo = splitOversizePages(pages);
  if (splitInfo.to !== splitInfo.from) pages = pickPages();

  // 分页会把段落搬到别的页，浮动元素的纸张坐标要在分页之后再落一次
  applyAnchors();

  postToHost({
    type: 'log',
    message: `Word 结构：${splitInfo.from === pages.length ? `${pages.length} 页` : `重排 ${splitInfo.from}→${pages.length} 页（含超长页 ${splitInfo.split} 个）`}`
      + (tocFixed.fixed ? `，目录项修正 ${tocFixed.fixed}` : '')
      + (anchorInfo.floats ? `，浮动图片 ${anchorInfo.floats}` : '')
      + (anchorInfo.boxes ? `，文本框 ${anchorInfo.boxes}` : '')
      + (anchorInfo.reserved ? `（占位 ${anchorInfo.reserved}）` : '')
      + (secInfo ? `，页眉页脚继承 ${secInfo.inherited}${secInfo.blankFirst ? `+空白首页 ${secInfo.blankFirst}` : ''}（${secInfo.sections} 节）` : '')
      + pageSpan(pages)
      + (secInfo ? `，预处理 ${preMs}ms${secInfo.ms ? `（解压 ${secInfo.ms.load}/取XML ${secInfo.ms.xml}/重打包 ${secInfo.ms.zip}）` : ''}` : '')
  });

  // 页面数异常多时不做分页改造（例如上千页的规范文档），全量堆叠更稳
  const tooMany = pages.length > MAX_PAGES_IN_DOM;

  body.innerHTML = '';
  const viewer = document.createElement('div');
  viewer.className = 'docx-viewer';
  const stage = document.createElement('div');
  stage.className = 'docx-stage';
  viewer.appendChild(stage);
  body.appendChild(viewer);

  // 把页面搬进 stage。
  // 【坑】绝不能把 wrapper 删掉：docx-preview 注入的样式表全是
  // `.docx-preview-wrapper > section.docx-preview { width/padding/background … }`
  // 这种带父级的选择器，删了 wrapper 页面就丢失宽度与白底，表现为"一片空白"。
  // 保留它，靠 CSS 的 `display: contents` 让它不参与布局即可。
  if (wrapper) {
    stage.appendChild(wrapper);
  } else if (pages.length) {
    for (const p of pages) stage.appendChild(p);
  }
  off.remove();

  const pageCount = pages.length || 1;
  const singlePageMode = !tooMany && pages.length > 1;

  // 页数极多、退化为连续滚动时，页面要竖着排（默认 flex 方向是横排）
  if (!singlePageMode) {
    stage.style.flexDirection = 'column';
    stage.style.alignItems = 'center';
  }

  let page = 1;
  let spread = spreadPref && singlePageMode;
  let zoom = zoomPref;
  let naturalW = 0, naturalH = 0;
  let destroyed = false;

  // 自然页尺寸要在未缩放时量
  stage.style.zoom = '';
  if (pages[0]) {
    naturalW = pages[0].offsetWidth || 0;
    naturalH = pages[0].offsetHeight || 0;
  }
  if (!naturalW) naturalW = 794;    // A4 @96dpi 兜底
  if (!naturalH) naturalH = 1123;

  // 与 PDF 保持一致：左右各留 24px 给翻页箭头，扣掉 stage 自身的 padding
  function avail(): { w: number; h: number } {
    const cw = viewer.clientWidth || 960;
    const ch = viewer.clientHeight || 640;
    return {
      w: Math.max(120, cw - STAGE_PAD_X * 2 - 48),
      h: Math.max(120, ch - STAGE_PAD_Y * 2 - 8)
    };
  }

  // 「适应窗口」= 整页可见（宽、高都要放得下），观感和 PDF 一致；
  // 之前只按宽度算，A4 页在常见窗口里会明显高出可视区，看起来"没自适应"。
  //
  // 例外：docx-preview 只能按 w:pageBreakBefore / w:lastRenderedPageBreak 切页，
  // 很多文档（如 WPS/第三方工具导出的）两者都没有，只能切成寥寥几页，
  // 单页里塞进好几页的内容（实测有 5103px 高、A4 才 1123px）。
  // 这种"超长页"若仍按高度适应，会被压到 25%，字小到看不清 —— 改按宽度适应，
  // 超出视口的部分用滚动查看（滚轮到底会自动翻下一页）。
  function fitPercent(): number {
    const a = avail();
    const maxW = spread ? Math.max(80, (a.w - PAGE_GAP) / 2) : a.w;
    const byW = maxW / naturalW;
    const byH = a.h / naturalH;
    const tallPage = naturalH / naturalW > 1.75;   // A4 是 1.42
    return Math.round((tallPage ? Math.min(byW, 1) : Math.min(byW, byH)) * 100);
  }

  function applyZoom(): void {
    const k = zoom > 0 ? zoom / 100 : fitPercent() / 100;
    // zoom 用百分比字符串，避免小数精度导致 1px 抖动
    stage.style.zoom = String(Math.max(0.1, k));
  }

  function visibleRange(): number[] {
    if (!singlePageMode) return pages.map((_, i) => i);
    return spread ? [page - 1, page].filter((i) => i >= 0 && i < pages.length) : [page - 1];
  }

  function paintPages(): void {
    if (!singlePageMode) return;
    const show = new Set(visibleRange());
    pages.forEach((p, i) => { p.style.display = show.has(i) ? '' : 'none'; });
    // 双页模式下按行排布，第二页要贴在第一页右边
    stage.style.flexWrap = spread ? 'nowrap' : 'nowrap';
  }

  const step = (): number => (spread ? 2 : 1);

  function updateBar(): void {
    const hint = bar.querySelector('.pb-index');
    bar.innerHTML = '';
    const nm = document.createElement('span');
    nm.className = 'pb-name';
    nm.textContent = opts.name;
    bar.appendChild(nm);

    const last = spread ? Math.min(pageCount, page + 1) : page;
    const range = last > page ? `${page}-${last}` : `${page}`;
    const info = document.createElement('span');
    const modeText = singlePageMode ? (spread ? '双页' : '单页') : '滚动';
    info.textContent = `Word · ${singlePageMode ? `第 ${range} / ${pageCount} 页 · ${modeText}` : `${pageCount} 页`}`
      + ` · ${zoom === 0 ? '适应窗口' : zoom + '%'}`;
    bar.appendChild(info);
    if (hint) bar.appendChild(hint);

    mountZoomControl(bar, {
      value: zoom,
      fitPercent,
      onChange: (v) => {
        if (zoom === v) return;
        zoom = v;
        zoomPref = v;
        applyZoom();
        updateBar();
        postToHost({ type: 'log', message: `Word 缩放：${v === 0 ? '适应窗口' : v + '%'}` });
      }
    });
  }

  function show(n: number): void {
    if (!singlePageMode) return;
    if (spread && n % 2 === 0 && n > 1) n -= 1;
    const changed = Math.max(1, Math.min(pageCount, n));
    const moved = changed !== page;
    page = changed;
    paintPages();
    // 换页后回到页首，否则长页会停在上一次的滚动位置，看着像"翻页没生效"
    if (moved) {
      viewer.scrollTop = 0;
      viewer.scrollLeft = 0;
    }
    updateBar();
    updateNav();
  }

  const btnPrev = document.createElement('button');
  btnPrev.className = 'pdf-nav pdf-prev';
  btnPrev.type = 'button';
  btnPrev.title = '上一页（← / PageUp / 滚轮上滚）';
  btnPrev.textContent = '‹';
  const btnNext = document.createElement('button');
  btnNext.className = 'pdf-nav pdf-next';
  btnNext.type = 'button';
  btnNext.title = '下一页（→ / PageDown / 滚轮下滚）';
  btnNext.textContent = '›';
  if (singlePageMode) {
    viewer.appendChild(btnPrev);
    viewer.appendChild(btnNext);
  }

  function updateNav(): void {
    if (!singlePageMode) return;
    btnPrev.classList.toggle('disabled', page <= 1);
    btnNext.classList.toggle('disabled', page + step() > pageCount);
  }

  // 单页 / 双页切换按钮
  let btnMode: HTMLButtonElement | null = null;
  if (singlePageMode) {
    const modes = document.createElement('div');
    modes.className = 'docx-modes';
    btnMode = document.createElement('button');
    btnMode.type = 'button';
    btnMode.className = 'pdf-mode';
    modes.appendChild(btnMode);
    viewer.appendChild(modes);
  }

  function syncMode(): void {
    if (!btnMode) return;
    btnMode.textContent = spread ? '双页' : '单页';
    btnMode.title = spread ? '当前：双页浏览（点击切换为单页）' : '当前：单页浏览（点击切换为双页）';
  }

  const pager: Pager = {
    get pageCount() { return pageCount; },
    get page() { return page; },
    next(): boolean {
      if (!singlePageMode) return false;
      const n = page + step();
      if (n > pageCount) return false;
      show(n);
      return true;
    },
    prev(): boolean {
      if (!singlePageMode) return false;
      const n = page - step();
      if (n < 1) return false;
      show(n);
      return true;
    },
    goto(n: number): void { show(n); },
    destroy(): void {
      destroyed = true;
      try { styleHost.remove(); } catch { /* 忽略 */ }
    }
  };

  if (btnMode) {
    btnMode.addEventListener('click', (e) => {
      e.stopPropagation();
      spread = !spread;
      spreadPref = spread;
      syncMode();
      applyZoom();
      show(page);
      postToHost({ type: 'log', message: `Word 切换为${spread ? '双页' : '单页'}浏览` });
    });
  }

  btnPrev.addEventListener('click', (e) => { e.stopPropagation(); pager.prev(); });
  btnNext.addEventListener('click', (e) => { e.stopPropagation(); pager.next(); });

  // 滚轮翻页（单页模式）
  //
  // 页面比视口高时（docx 分页不精确，一页塞了多页内容）不能直接把滚轮交还给原生滚动：
  // 那样滚到页面底部就停住、永远翻不到下一页（表现为"滚轮无法一直往下翻"）。
  // 正确做法是：页内还能滚就滚，滚到顶/底再翻页。
  let wheelAcc = 0;
  let wheelUntil = 0;
  viewer.addEventListener('wheel', (e: WheelEvent) => {
    if (destroyed || !singlePageMode) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const canY = viewer.scrollHeight > viewer.clientHeight + 2;
    if (canY) {
      // 剩余可滚动量已经不到 1/5 屏时直接翻页：A4 页在常见缩放下往往只多出几十像素，
      // 若要求"滚到像素级底部"才翻页，用户每页都要多滚一下，手感很黏。
      const near = Math.max(100, viewer.clientHeight * 0.2);
      const remainDown = viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop;
      const remainUp = viewer.scrollTop;
      if (dy > 0 ? remainDown > near : remainUp > near) return;   // 本页还有内容没看完
    }

    e.preventDefault();
    const now = Date.now();
    if (now < wheelUntil) return;
    wheelAcc += dy;
    if (Math.abs(wheelAcc) < 24) return;
    const dir: 1 | -1 = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    wheelUntil = now + 130;
    const moved = dir > 0 ? pager.next() : pager.prev();
    if (!moved && opts.onBoundary) opts.onBoundary(dir);
  }, { passive: false });

  // 窗口尺寸变化时"适应窗口"要重算
  let resizeTimer = 0;
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (destroyed || stale()) return;
        if (zoom === 0) {
          applyZoom();
          updateBar();      // 适应比例变了，底部百分比要跟着刷新
        }
      }, 150);
    });
    ro.observe(viewer);
  }

  applyZoom();
  paintPages();
  syncMode();
  updateBar();
  updateNav();

  // 一行日志带上布局数值：Word 预览一旦"只剩灰底没有内容"，几乎都是
  // 页面没查到 / 宽度算成 0 / zoom 异常，这几个数能直接定位。
  const shown = pages.filter((p) => p.style.display !== 'none').length;
  postToHost({
    type: 'log',
    message: `Word 就绪：${pageCount} 页（${singlePageMode ? (spread ? '双页' : '单页') : '滚动'}，`
      + `适应窗口 ${fitPercent()}%，实际 ${stage.style.zoom || '无'}，`
      + `首页 ${pages[0] ? pages[0].offsetWidth + 'x' + pages[0].offsetHeight : '无'}，显示 ${shown}/${pageCount}）`
  });

  const oldDestroy = pager.destroy.bind(pager);
  pager.destroy = (): void => {
    if (ro) ro.disconnect();
    window.clearTimeout(resizeTimer);
    oldDestroy();
  };

  return pager;
}
