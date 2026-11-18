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
import { postToHost, requestEmfPng } from './host';
import { mountZoomControl } from './zoom';
import type { Pager } from './pdfview';
import type { DocxPrepInfo } from './docxsec';

export interface DocxViewerOptions {
  name: string;
  stale: () => boolean;
  onBoundary?: (dir: 1 | -1) => void;
  /**
   * 阶段进度。大文档（30MB / 上千页）渲染要几十秒，必须让用户看到「在动」，
   * 否则界面一直停在「解析文档…」，会被当成卡死。
   */
  progress?: (text: string) => void;
}

/**
 * 把主线程让出去一帧。
 *
 * 【为什么必须有】页面里所有长任务（解包、逐张转元文件、上千次分页测量）都是同步的，
 * 一旦连成一片，点击事件只能排在任务队列里 —— 用户按右上角 × 没反应，
 * 看着就是"关不掉的假死"（实测 30MB 手册渲染 40 秒，3 次点击全部堆在结束那一刻才执行）。
 * 每批之间 setTimeout(0) 一次，浏览器就有机会跑事件循环、把点击处理掉。
 */
const yieldToUI = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 0); });

/**
 * 让浏览器真正把当前画面刷出去（两次 rAF 才保证本帧已提交）。
 * 用在「提示文案改完、马上要进一段几十秒的同步重活」的地方 ——
 * 只用 setTimeout(0) 时文案可能还没画出来就被重活堵住了。
 */
const paintFrame = (): Promise<void> => new Promise<void>((r) => {
  requestAnimationFrame(() => { requestAnimationFrame(() => { r(); }); });
});

// 与 PDF 一致：单页/双页、缩放都跨文件保持
let spreadPref = false;
let zoomPref = 0;

// docxsec 是动态 import 的（它带 JSZip，塞进首屏包不划算），
// 页码回填要等到分页之后才用，所以在这里留一个引用。
let fillPageFieldsFn: ((root: ParentNode, pageNo: number, total: number) => number) | null = null;

/** 交给 docx-preview 的渲染选项。整篇与首屏迷你包必须完全一致，否则第 1 页会不一样。 */
const RENDER_OPTS = {
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
};

const PAGE_GAP = 14;
// 必须和 style.css 里 .docx-stage 的 padding 保持一致（18px 24px）
const STAGE_PAD_X = 24;
const STAGE_PAD_Y = 18;
// 页数超过这个量级才退回连续滚动。以前是 400，导致 402 页的 114MB 手册永远只有
// 连续滚动、连单双页按钮都没有；现在分页成本已经从 55 秒降到几秒，没必要再挡。
const MAX_PAGES_SINGLE = 2000;

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

// 【坑，v1.9.2 修】量尺寸之前必须等图片解码完、字体落地。
// docx-preview 的图片是 `<img src="blob:…">`，renderAsync 返回时它们还没 load，
// getBoundingClientRect() 的高度是 0 —— 按页拆分时把这些图当成"不占地方"，
// 估出来的页高严重偏小（实测某节估算 790px、图片就位后实际 2319px），
// 分页结果就是「有的页塞爆、有的页空着三成」，全篇页数从 94 页涨到 128 页。
// 字体同理：字体没落地时按回退字体量，行高与折行都对不上。
async function waitAssetsReady(root: HTMLElement, timeoutMs = 3000): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
  // 【坑，v1.9.6 修】以前无差别等所有图片解码，1789 张图的手册光等这一段就 18 秒 ——
  // 而这些等待一张都不影响分页：docx-preview 的 parsePicture 已经把 wp:extent 的
  // cx/cy 写成了 img 的 CSS 宽高（result.cssStyle.width/height），所以图片**没解码
  // 也已经占好了位置**，量出来就是最终高度。
  // 只有少数没有 ext 的图（VML、手写 drawing）才必须靠自然尺寸撑开，只等它们。
  const pending = imgs.filter((i) => {
    if (i.complete) return false;
    const w = parseFloat(i.style.width);
    const h = parseFloat(i.style.height);
    return !(w > 0 && h > 0);
  });
  if (pending.length) {
    await Promise.race([
      Promise.all(pending.map((i) => new Promise<void>((res) => {
        i.addEventListener('load', () => res(), { once: true });
        i.addEventListener('error', () => res(), { once: true });
      }))),
      new Promise<void>((res) => setTimeout(res, timeoutMs))
    ]);
  }
  try { await (document as any).fonts?.ready; } catch { /* 老内核没有字体 API */ }
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

/**
 * 舞台当前的缩放系数。
 *
 * 预显示改成"一出现就是适应窗口"之后，舞台带着 CSS `zoom`，而 getBoundingClientRect
 * 返回的是**缩放后**的坐标 —— 把 rect 差值直接写到 style.left 上会小一圈
 * （zoom 0.79 时偏小 21%，浮动图整体往左上缩）。量 rect 的地方一律先除以它。
 */
function zoomFactor(el: Element | null): number {
  const st = (el as HTMLElement | null)?.closest('.docx-stage') as HTMLElement | null;
  const z = st ? parseFloat(st.style.zoom || '1') : 1;
  return z > 0 && isFinite(z) ? z : 1;
}

function collectAnchors(root: HTMLElement, reset = true): { floats: number; boxes: number; reserved: number } {
  // 【坑，v1.11】root 本身可能就是一张 section（首屏只处理第 1 节时会这么传）。
  // querySelectorAll('section') 只查后代、不含自己 —— 传 section 时列表恒为空，
  // 于是这一节的浮动图一个都没被摘出文档流，白占几百像素：
  // 实测封面那张 behindDoc 的大图算成 385px，把后面 4 个块整段挤到第 2 页，
  // 换装时第 1 页的内容当场变脸（迷你包 18 块一页 → 整篇 14+4 两块）。
  const secs = (root.tagName === 'SECTION' ? [root] : [])
    .concat(Array.from(root.querySelectorAll('section')) as HTMLElement[]);
  let floats = 0, boxes = 0, reserved = 0;
  // 同一会话里连续预览多个文档，旧记录要丢掉。
  // 但首屏优化把「第 1 节」和「其余节」分两次调用，第二次不能清掉第一次的记录
  //（否则封面的浮动图位置丢失，分页后会跳回文档流）。
  if (reset) anchors.length = 0;
  const zk = zoomFactor(root);

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
      push(w, p, (ir.left - pr.left) / zk, (ir.top - pr.top) / zk);
      floats++;
    }

    // ② 绝对定位的文本框（docx-preview 渲染成 svg + foreignObject）。
    // 只用 foreignObject 认文本框：VML 水印/图形也是 position:absolute 的 svg，
    // 它们的坐标本来是对的，动它们反而会把水印挪位。
    //
    // 【坑】首屏优化把它拆成两次调用（先第 1 节、再其余节），而这里处理完的 svg
    // 仍然是 position:absolute —— 第二次调用会再匹配一遍，重复记录 + 重复撑高段落。
    // 打个标记让第二次跳过。
    const svgs = (Array.from(sec.querySelectorAll('svg')) as unknown as HTMLElement[]).filter((s) => {
      if ((s as any).dataset?.qpAnchor) return false;
      return /position\s*:\s*absolute/i.test(s.getAttribute('style') || '') && !!s.querySelector('foreignObject');
    });
    for (const svg of svgs) {
      (svg as any).dataset.qpAnchor = '1';
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
// （zoom 可能已经设上，所以坐标一律除以缩放系数换算回布局值，见 zoomFactor）
function applyAnchors(): void {
  if (!anchors.length) return;
  const zk = zoomFactor(anchors[0].p);
  for (const a of anchors) {
    const sec = a.p.closest('section') as HTMLElement | null;
    if (!sec) continue;
    sec.style.position = 'relative';
    const pr = a.p.getBoundingClientRect();
    const sr = sec.getBoundingClientRect();
    a.el.style.position = 'absolute';
    a.el.style.left = `${Math.round((pr.left - sr.left) / zk + a.dx)}px`;
    a.el.style.top = `${Math.round((pr.top - sr.top) / zk + a.dy)}px`;
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

const pageBoxCache = new WeakMap<HTMLElement, PageBox>();

function pageBox(sec: HTMLElement): PageBox {
  // 缓存：分页时同一张纸要量几千次，每次 getComputedStyle 都会强制同步重排；
  // 上千页的文档里这就是几十秒的来源之一。min-height 由 docx-preview 写在 inline
  // style 上、分页过程中不会变，所以可以安全缓存（取不到 min-height 的少数情况不缓存）。
  const hit = pageBoxCache.get(sec);
  if (hit) return hit;

  const cs = getComputedStyle(sec);
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  // min-height 就是 docx-preview 从 sectPr 写进来的纸张高度（A4 = 841.9pt = 1122.5px）
  const minH = parseFloat(cs.minHeight) || 0;
  const pageH = minH || sec.offsetHeight || 1122.5;
  const box = { pageH, padT, padB, inner: Math.max(120, pageH - padT - padB) };
  if (minH) pageBoxCache.set(sec, box);
  return box;
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
  // offsetHeight 而不是 rect.height：rect 会受舞台 zoom 影响（见 cutSection 里的说明）
  const heights = bodyRows.map((r) => r.offsetHeight);

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
//
export function cutSection(sec: HTMLElement, limit: number): HTMLElement[] {
  const art = sec.querySelector(':scope > article') as HTMLElement | null;
  if (!art) return [];
  const kids = Array.from(art.children) as HTMLElement[];
  if (!kids.length) return [];

  const head = sec.querySelector(':scope > header');
  const foot = sec.querySelector(':scope > footer');
  const made: HTMLElement[] = [];
  let curSec = sec;
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
    curSec = ns;
    curArt = na;
    acc = 0;
  };

  // 一次性量完估算占位，避免边搬边测反复重排。
  // 队列会在拆表时就地插入新段，所以量好的高度也同步用数组维护。
  //
  // 【坑，v1.9.2 修】估算不能用 blockHeight（= rect 高 + marginTop + marginBottom）：
  // 流内相邻段落的上下外边距会折叠成 max(上, 下)，逐块把两个边距都加上等于
  // 把行距算了两遍。实测一页 6 段估 704px、实际只占 617px，每页凭空少装一成半内容，
  // 128 页里有 78 页空着三成 —— 页数比 Word 的 94 页多出三分之一。
  // 改用「累计底边之差」：第 i 块的占位 = 它自己的底边 − 前一块的底边，
  // 这个差值天然包含折叠后的真实间距。
  //
  // 【坑，v1.11 修】这里**不能用 getBoundingClientRect 的原始值**：舞台带着
  // CSS zoom（适应窗口 79%），rect 会被按比例缩小 ⇒ 块高全线偏小 ⇒ 分页切错。
  // 除以 zoomFactor 换算回布局值即可（一次除法，不影响精度）。
  //
  // 【坑】也**不要**换成 offsetTop+offsetHeight：块的 offsetParent 未必是 article
  //（页面里只要有 position:relative 的祖先就会改基准），混着算出来的差分整体偏大
  // 约 5%，表现为"每页底部空出两行"（实测 114MB 那份从 404 页涨到 461 页、
  // 页高 1077~1123 不齐）。rect 是视口坐标，同一篇里基准天然一致。
  const zk = zoomFactor(art);
  const baseTop = art.getBoundingClientRect().top;
  let prevBottom = 0;
  const queue = kids.slice();
  const qh = kids.map((k) => {
    // 浮动图片/文本框已经被摘成 absolute，不参与流内占位
    if (getComputedStyle(k).position === 'absolute') return 0;
    const bottom = (k.getBoundingClientRect().bottom - baseTop) / zk;
    const h = Math.max(0, bottom - prevBottom);
    prevBottom = Math.max(prevBottom, bottom);
    return h;
  });

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

    curArt.appendChild(queue[i]);
    acc += kh;

    // 【v1.11 大文档提速】不再「每块放进去、量一次、溢出再退回来」。
    //
    // qh 是「累计底边之差」，而一个块的高度只取决于它自己的内容和它的宽度 ——
    // 宽度在这一节里是恒定的，页眉页脚是绝对定位、不占正文高度，
    // 所以**块落在第几页并不改变它的高度**，估算就是实测。
    // 以前每页要读 2~3 次 offsetHeight，一个 390 页的超长节就是上千次强制布局，
    // 单节分页因此要几十秒（404 页的 114MB 手册实测 51 秒）。
    // 现在只在「按估算装不下」时换页，一次布局都不用在这里付。
    //
    // 兜底：万一估算偏小导致某页真的溢出，paginate 的递归（depth+1）会把它再切一次；
    // 回归时看日志里的「页高 xxx~yyy（不齐）」就能发现。
    if (acc > limit && curArt.children.length > 1) {
      curArt.removeChild(queue[i]);
      acc -= kh;
      newPage();
      i--;                                  // 这一块没装下，下一轮从新页重新装
    }
  }

  // 切出来的页里偶尔会剩一张没有内容的空壳（估算/实测来回退让时新建、又没用上）。
  // 用户看到的是一张白纸，直接摘掉 —— 空页上没有内容，删掉不影响排版。
  for (let i = made.length - 1; i >= 0; i--) {
    const a = made[i].querySelector(':scope > article');
    if (!a || !a.children.length) {
      made[i].remove();
      made.splice(i, 1);
    }
  }
  return made;
}

// 反复切，直到这一页不再溢出（或切不动 / 轮次用完）。
function paginate(sec: HTMLElement, depth = 0): HTMLElement[] {
  const box = pageBox(sec);
  if (sec.offsetHeight - box.pageH <= 2 || depth >= 3) return [sec];

  const made = cutSection(sec, box.inner);
  if (!made.length) return [sec];

  // 【v1.11】切页改成纯估算（不再每块实测，这是 51 秒 → 4 秒的关键），
  // 估算偶尔偏小、切出来的页仍会溢出。所以**第一页也要过一遍检查**：
  // 溢出的页在这里被再切一次，页高最终仍是等高的。多花的钱只落在溢出的那几页上。
  const out: HTMLElement[] = [];
  for (const p of [sec, ...made]) out.push(...paginate(p, depth + 1));
  return out;
}

/** 一页里的正文块数（article 的直接子元素），用于比对"第 1 页有没有变" */
function kidCount(sec: HTMLElement | undefined): number {
  if (!sec) return -1;
  const art = sec.querySelector(':scope > article');
  return art ? art.children.length : -1;
}

/**
 * 丢掉「首段分页」造出来的假空白页。
 *
 * docx-preview 的 splitBySection 遇到 pageBreakBefore 就把**当前页已经累积的内容**
 * 切出去当一页。如果这个段落正好是正文第一个段落，切出去的就是一张空页 ——
 * 而 Word 里根本不会有这一页（最开头没有内容可分，分了也分不出新页）。
 *
 * 判据在 docxsec 的 firstParaBreakBefore（沿 basedOn 链看样式），这里只负责摘。
 * 保守起见：只有在「第 1 个 section 的正文完全为空」且「后面还有别的 section」时才摘，
 * 免得把真正的空白页（比如单独的扉页）或空文档清成一片白。
 */
function dropBlankFirstSection(w: HTMLElement): void {
  const secs = Array.from(w.querySelectorAll(':scope > section')) as HTMLElement[];
  if (secs.length < 2) return;
  const first = secs[0];
  const art = first.querySelector(':scope > article');
  if (!art) return;
  if (art.children.length) return;
  // article 空了也可能有浮动元素被挪到了别处，确认这一节的正文真的什么都没画。
  // 【只看 article 里面】页眉里常有一张 SVG 水印，按整节查会永远命中、永远删不掉。
  if (art.querySelector('img, table, svg')) return;
  first.remove();
}

/** 预处理分步耗时压成一行日志（只列 ≥20ms 的项，否则太吵） */
function prepBreakdown(ms?: DocxPrepInfo['ms']): string {
  if (!ms) return '';
  const items: Array<[string, number]> = [
    ['解压', ms.load], ['取XML', ms.xml], ['页眉页脚', ms.hf || 0], ['编号', ms.num || 0],
    ['页码域', ms.fields || 0], ['元文件', ms.emf || 0], ['自检', ms.check || 0],
    ['迷你包', ms.mini || 0], ['重打包', ms.zip]
  ];
  return items.filter(([, v]) => v >= 20).map(([k, v]) => `${k} ${v}`).join(' / ');
}

// 分页后每一页的高度应当**等于它自己那张纸的高度**。
//
// 【别看 min~max】同一篇文档里可以有好几种纸型（实测某手册同时有 A4 1122.5px 和
// 自定义 1077.3px 两种 pgSz），min~max 差 148px 是纸型不同、完全正常，
// 拿它当"高低不齐"的判据只会制造假警报。
// 真正要盯的是"某一页被内容撑得比它的纸还高"（拆不开的长表格/大图）：逐页跟
// 自己的 min-height 比，超出的才算问题。
function pageSpan(pages: HTMLElement[]): string {
  const marks = new Set<number>();
  let over = 0;
  let overMax = 0;
  for (const p of pages) {
    const h = p.offsetHeight;
    if (!h) continue;
    const paper = pageBox(p).pageH;
    marks.add(Math.round(paper));
    const d = h - paper;
    if (d > 2) {
      over++;
      overMax = Math.max(overMax, Math.round(d));
    }
  }
  if (!marks.size) return '';
  const list = Array.from(marks).sort((a, b) => a - b).join('/');
  return `，纸型 ${list}px，${over ? `撑高 ${over} 页（最多 +${overMax}px）` : '无撑高'}`;
}

export async function renderDocxViewer(
  ab: ArrayBuffer, body: HTMLElement, bar: HTMLElement, opts: DocxViewerOptions
): Promise<Pager | null> {
  const stale = opts.stale;
  const tBoot = Date.now();

  const { renderAsync } = await import('docx-preview');
  if (stale()) return null;

  // ===== 舞台（先只建节点，等真有内容要显示时才挂进页面）=====
  //
  // 【为什么提前建】迷你包渲染完就要立刻显示第 1 页，而那时预处理（重打包）
  // 还没结束 —— 舞台不能等到"整篇渲染完"才建。
  //
  // 【v1.11 关键改动：一出现就是最终形态】
  // 以前是"先连续滚动把整篇挂出去 → 后处理跑完再切成单页/双页"，
  // 用户看到的是「一张长文档」1 秒后突然变成「一页小纸」—— 那次布局跳变极其明显
  //（方向 column→row、zoom 100%→79%、另外 208 页瞬间消失、滚动位置归零）。
  //
  // 现在：舞台建好先藏起来（visibility:hidden 仍参与布局，能量尺寸），
  // 等第 1 节切完、缩放算好、只显示第 1 页之后才一次性露出来。
  // 用户第一眼看到的就是最终形态，后面页数增长、页码回填都在"用户已经在读"之后，
  // 而且都是「追加/改文字」，不再有第二次布局跳变。
  const viewer = document.createElement('div');
  viewer.className = 'docx-viewer';
  const stage = document.createElement('div');
  stage.className = 'docx-stage';
  stage.style.visibility = 'hidden';
  viewer.appendChild(stage);

  // 当前挂在舞台上的 wrapper。迷你包 → 整篇换装时会被替换掉，所以不能写成 const。
  // ⚠️ 用一个对象包一层，不要写成裸的 `let pageHost: HTMLElement | null = null`：
  // TS 的控制流分析只认当前函数里的赋值，会把「只在 mount() 里赋值」的变量
  // 一直判成 null，后面每次读取都被收窄成 never（报 TS2339）。
  const host = { el: null as HTMLElement | null };
  function mount(w: HTMLElement): void {
    if (host.el === w) return;
    if (host.el) stage.replaceChild(w, host.el);
    else stage.appendChild(w);
    host.el = w;
  }

  // 把舞台挂进预览区。⚠️ 必须 place 掉 .loading：预览区是 flex 行容器，
  // 那句提示是两个字符的 flex item，会把 .docx-viewer 的 clientWidth 挤小，
  // 于是"适应窗口"算出来的比例跟真实可用宽度不一致 —— 第一眼是 78%、收尾变 79%。
  function attach(): void {
    if (viewer.isConnected) return;
    body.innerHTML = '';
    body.appendChild(viewer);
  }

  const styleHost = document.createElement('div');
  document.body.appendChild(styleHost);

  /**
   * 离屏渲染一张 docx（离屏容器 1000px 宽，只当"产房"），返回 docx-preview 产出的
   * wrapper —— 我们后面把它搬进舞台。
   *
   * 【坑】docx-preview 的类名是从 options.className 派生的：
   *   wrapper 类名 = `${className}-wrapper`，页面是 `section.${className}`
   * 我们传的是 className:'docx-preview'，所以真实 DOM 是
   *   div.docx-preview-wrapper > section.docx-preview
   * 而不是官方 README 里常见的 .docx-wrapper / section.docx。
   * 之前按 .docx-wrapper / section.docx 查，querySelectorAll 返回 0 个，
   * pageCount 兜底成 1、singlePageMode=false、paintPages 直接 return，
   * 页面元素虽在 DOM 里但样式与显示逻辑全部落空 —— 表现就是"整页空白"。
   */
  async function renderInto(src: ArrayBuffer | Blob, dropBlankFirst = false): Promise<HTMLElement | null> {
    const off = document.createElement('div');
    off.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px;';
    document.body.appendChild(off);
    let w: HTMLElement | null;
    try {
      await renderAsync(src, off, styleHost, RENDER_OPTS);
      w = (off.querySelector('.docx-preview-wrapper')
        || off.querySelector('[class$="-wrapper"]')) as HTMLElement | null;
    } catch (e) {
      off.remove();
      throw e;
    }
    if (!w) { off.remove(); return null; }
    if (dropBlankFirst) dropBlankFirstSection(w);
    off.removeChild(w);
    off.remove();
    return w;
  }

  // ===== ④ 阅读器状态（预显示与最终状态共用同一套变量/函数） =====
  let pages: HTMLElement[] = [];       // 当前已排好的页（分页推进时持续增长）
  let page = 1;
  let spread = spreadPref;
  let zoom = zoomPref;
  let naturalW = 794;                  // A4 @96dpi
  let naturalH = 1123;
  let singlePageMode = false;
  let paginating = false;              // 分页还在推进（状态栏带「排版中」）
  let destroyed = false;

  const pageCount = (): number => pages.length || 1;

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

  function measure(): void {
    const p0 = pages[0];
    if (!p0) { naturalW = 794; naturalH = 1123; return; }
    naturalW = p0.offsetWidth || 794;
    // 纸高优先取 min-height（= sectPr 里的纸张高度）而不是 offsetHeight：
    // 还没分页的节可能被内容撑成好几页高（5103px vs 1123px），拿它算缩放会把
    // 整页压到 25%；而分页之后每页高度正好等于纸高 ⇒ 预显示与分页后用同一个
    // 基准算出来的缩放完全一致，这才是"后面不再跳一下"的前提。
    naturalH = pageBox(p0).pageH || p0.offsetHeight || 1123;
  }

  // 隐藏非当前页用「挪出可视区 + visibility:hidden」，**不能用 display:none**。
  //
  // 【坑，v1.9.2 修】docx-preview 的多级编号是纯 CSS 计数器实现的
  // （p.num-1-1:before { counter-increment: … }，根元素 counter-reset）。
  // 计数器只在「生成了盒子的元素」上累加 —— display:none 的页面整棵子树
  // 不参与计数，于是单页/双页模式下前面几十页的标题编号全部丢失：
  // 第 5 章显示成「1 功能说明」、5.1 显示成「0.1」、5.1.1 显示成「0.1.1」。
  // position:absolute + visibility:hidden 让页面仍然参与布局（因此计数器连续），
  // 但完全不可见、也不响应鼠标；负 left 不会产生滚动条（滚动溢出只认右下方向）。
  function setPageHidden(p: HTMLElement, hidden: boolean): void {
    if (hidden) {
      p.style.position = 'absolute';
      p.style.left = '-99999px';
      p.style.top = '0';
      p.style.visibility = 'hidden';
      p.style.pointerEvents = 'none';
    } else {
      p.style.position = '';
      p.style.left = '';
      p.style.top = '';
      p.style.visibility = '';
      p.style.pointerEvents = '';
    }
  }

  function visibleRange(): number[] {
    if (!singlePageMode) return pages.map((_, i) => i);
    return spread ? [page - 1, page].filter((i) => i >= 0 && i < pages.length) : [page - 1];
  }

  function paintPages(): void {
    if (!singlePageMode) return;
    const on = new Set(visibleRange());
    pages.forEach((p, i) => setPageHidden(p, !on.has(i)));
  }

  // 【坑，v1.9.3】必须显式定方向。docx-preview 自己注入的规则是
  //   `.docx-preview-wrapper { display:flex; flex-flow:column; align-items:center }`，
  // 只要不覆盖 flex-direction，就一直是 column：此时 style.css 里的
  // `align-items:flex-start` 作用在交叉轴（水平）上 ⇒ 单页被顶到左边、右侧一片灰；
  // 双页则纵向堆叠，第二页跑到视口外 ⇒ 看着永远只有一页。
  function setFlow(): void {
    const ph = host.el;
    if (!ph) return;
    if (singlePageMode) {
      ph.style.flexDirection = 'row';
      ph.style.alignItems = 'flex-start';
      ph.style.justifyContent = 'center';
      ph.style.flexWrap = 'nowrap';
      stage.style.flexDirection = 'row';
    } else {
      ph.style.flexDirection = 'column';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'flex-start';
      ph.style.flexWrap = 'nowrap';
      stage.style.flexDirection = 'column';
    }
    stage.style.alignItems = 'center';
    stage.style.justifyContent = 'flex-start';
  }

  function updateBar(): void {
    const hint = bar.querySelector('.pb-index');
    bar.innerHTML = '';
    const nm = document.createElement('span');
    nm.className = 'pb-name';
    nm.textContent = opts.name;
    bar.appendChild(nm);

    const info = document.createElement('span');
    const zt = zoom === 0 ? '适应窗口' : zoom + '%';
    if (!singlePageMode) {
      info.textContent = `Word · ${pages.length} 页 · ${zt}`;
    } else {
      const last = spread ? Math.min(pageCount(), page + 1) : page;
      const range = last > page ? `${page}-${last}` : `${page}`;
      // 分页还在推进时总页数会一直变，加个「+」和「排版中」说明这是暂时的
      const total = paginating ? `${pages.length}+` : String(pages.length);
      info.textContent = `Word · 第 ${range} / ${total} 页 · ${spread ? '双页' : '单页'} · ${zt}`
        + (paginating ? ' · 排版中' : '');
    }
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

  const step = (): number => (spread ? 2 : 1);

  function show(n: number): void {
    if (!singlePageMode) return;
    if (spread && n % 2 === 0 && n > 1) n -= 1;
    const changed = Math.max(1, Math.min(pageCount(), n));
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
  viewer.appendChild(btnPrev);
  viewer.appendChild(btnNext);

  function updateNav(): void {
    if (!singlePageMode) {
      btnPrev.style.display = 'none';
      btnNext.style.display = 'none';
      return;
    }
    btnPrev.style.display = '';
    btnNext.style.display = '';
    btnPrev.classList.toggle('disabled', page <= 1);
    btnNext.classList.toggle('disabled', page + step() > pageCount());
  }

  // 单页 / 双页切换按钮
  const modes = document.createElement('div');
  modes.className = 'docx-modes';
  const btnMode = document.createElement('button');
  btnMode.type = 'button';
  btnMode.className = 'pdf-mode';
  modes.appendChild(btnMode);
  viewer.appendChild(modes);

  function syncMode(): void {
    btnMode.style.display = singlePageMode ? '' : 'none';
    btnMode.textContent = spread ? '双页' : '单页';
    btnMode.title = spread ? '当前：双页浏览（点击切换为单页）' : '当前：单页浏览（点击切换为双页）';
  }

  const pager: Pager = {
    get pageCount() { return pageCount(); },
    get page() { return page; },
    next(): boolean {
      if (!singlePageMode) return false;
      const n = page + step();
      // 分页还没排到这里：吞掉这次翻页（返回 true = "我处理了"），
      // 否则会一路走到 onBoundary 去切换文件 —— 用户只是翻页，不该跳文件。
      if (n > pageCount()) return paginating;
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

  btnMode.addEventListener('click', (e) => {
    e.stopPropagation();
    spread = !spread;
    spreadPref = spread;
    syncMode();
    applyZoom();
    show(page);
    postToHost({ type: 'log', message: `Word 切换为${spread ? '双页' : '单页'}浏览` });
  });

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

  /**
   * 分页必须固定在 100% 缩放下做。
   *
   * 【坑，v1.11】CSS `zoom` 不是"渲染完再缩放"，Chromium 会把 font-size 与各种长度
   * 先按 zoom 折一遍再排版 —— 同一段文字在 79% 与 100% 下的**折行不一样**，
   * 折行不一样块高就不一样，块高不一样分页结果就不一样。
   * 实测 114MB 那份的封面：100% 下 16 个块正好一页，79% 下变成 5+11 两页。
   * 于是"迷你包在 100% 切出第 1 页 → 换装时整篇在 79% 重切"会把第 1 页的内容当场改掉，
   * 用户看到的就是"内容自己变了一下"。
   *
   * 压到 100% 切完立刻恢复：一次同步块里两次重排，但中间不会刷帧；
   * 每节多两次重排的代价远小于"第 1 页自己变脸"。
   */
  function paginateUnit(sec: HTMLElement): HTMLElement[] {
    const prev = stage.style.zoom;
    const changed = !!prev && prev !== '1';
    if (changed) stage.style.zoom = '1';
    try { return paginate(sec); } finally { if (changed) stage.style.zoom = prev; }
  }

  // ===== ① 预处理：页眉页脚继承 / numId=0 / 页码域哨兵 / EMF→PNG =====
  // 不预处理的话：后面几十页没有页眉页脚、章节号整体 +1、每页都印「第 19 页，共 19 页」、
  // 符号标记全是碎图标 —— 这四件事浏览器侧都无解。
  let input: ArrayBuffer | Blob = ab;
  let secInfo: DocxPrepInfo | null = null;
  let preMs = 0;
  let miniMs = 0;
  let miniShown = false;
  /** 迷你包第 1 页的块数，-1 = 还没算（换装自检用） */
  let miniPage1Blocks = -1;
  const preStart = Date.now();
  try {
    const { prepareDocx, fillPageFields } = await import('./docxsec');
    fillPageFieldsFn = fillPageFields;
    opts.progress?.('正在打开文档…');
    const fixed = await prepareDocx(ab, {
      // 非 WebView2（Electron 开发模式）没有宿主可转换，返回 null 让它保持原样
      emfToPng: async (b64) => {
        const r = await requestEmfPng(b64);
        return r.ok && r.base64 ? r.base64 : null;
      },
      // 【v1.11】这里以前报「转换矢量图 3/70」，那是我们内部的活，跟用户要看的东西无关。
      // 用户原话：「为什么让用户看到那些跟用户想要的结果无关的内容」。
      // 统一成一句"在打开"，细节留给日志。
      onProgress: () => opts.progress?.('正在打开文档…'),
      // 迷你包在整篇重打包之前就做好了 —— 正好用来先把第 1 页交出去。
      // ⚠️ 这里必须**当场露出**，不能只把 wrapper 存起来等 prepareDocx 返回：
      // 返回之前还有一次整篇重打包（214MB 那份 15 秒），存着等于白等。
      onMini: async (blob, dropFirstBlank, mi) => {
        if (stale()) return;
        opts.progress?.('正在显示第 1 页…');
        let mw: HTMLElement | null = null;
        try {
          mw = await renderInto(blob, dropFirstBlank);
        } catch {
          mw = null;                   // 迷你包渲染失败就当没有，整篇照常走
        }
        if (mw) await showFirstPage(mw, mi);
      }
    });
    preMs = Date.now() - preStart;
    if (fixed) {
      if (fixed.data) input = fixed.data;
      secInfo = fixed.info;
    }
  } catch { /* 预处理失败不致命：按原样渲染，只是页眉页脚/编号/页码可能不准 */ }
  if (stale()) { styleHost.remove(); return null; }
  /**
   * 把迷你包的第 1 页立刻交出去。
   *
   * 【v1.12 关键修正】这段原来排在 `prepareDocx()` 返回之后 —— 等于白等：
   * 迷你包 2 秒就建好了，可整篇重打包还在 prepareDocx 里没做完，舞台就一直藏着。
   * 实测 214MB 那份手册：迷你包 461ms 就绪，首屏却是 17857ms，
   * 中间差额几乎全是那一步 15 秒的重打包。现在改成在 onMini 里就露，
   * 重打包在用户已经开始读第 1 页之后才跑。
   *
   * 【为什么能露】迷你包的 document.xml 只含前若干个块，其余部件（styles / numbering /
   * media / 页眉页脚）原样带上，节属性用的还是第 1 节自己的 sectPr ——
   * 所以它的第 1 页和整篇的第 1 页**完全一致**（分页只看块高，块高只取决于块自己的
   * 内容和列宽）。
   *
   * 【顺序很讲究】
   *   ① mount/等图/等制表位 都在舞台还没挂进页面时做 —— 此时不画任何东西，
   *      屏幕上仍是「正在显示第 1 页…」；
   *   ② 从 attach() 到露出的这一段**全是同步代码**，浏览器不会在中间刷帧，
   *      所以"第 1 页出现"是一个完整画面，不会有先白再刷的中间态。
   *
   * 返回 false 表示没露成（调用方照常走整篇渲染）。
   */
  async function showFirstPage(
    mw: HTMLElement,
    mi?: { totalBlocks: number; usedBlocks: number; atSectionEnd: boolean }
  ): Promise<boolean> {
    if (miniShown || stale()) return false;
    try {
      // 状态栏从这一刻起就该说「排版中」：此刻只切了迷你包里的前几节，
      // 页数还会一路长上去，不标出来的话用户会以为整篇只有 1 页。
      paginating = true;
      // 迷你包只需负责第 1 节。
      // 【为什么会有第二个节】切点正好落在第 1 节末尾时，document.xml 末尾还会
      // 补一份 body 级 sectPr（纸型用），docx-preview 会把它当成一个**空节** ⇒
      // 舞台里多出一张白纸（实测「切出 2 页，各页块数 18+0」）。直接丢掉。
      const msecs = Array.from(mw.querySelectorAll(':scope > section')) as HTMLElement[];
      if (!msecs.length) msecs.push(mw);
      for (let i = 1; i < msecs.length; i++) msecs[i].remove();
      msecs.length = 1;
      const mT0 = Date.now();
      mount(mw);
      await waitAssetsReady(msecs[0], 600);
      if (stale()) return false;
      await waitTabStopsReady(mw);
      if (stale()) return false;
      const mReadyMs = Date.now() - mT0;

      // —— 以下到 stage 露出之间不能有任何 await ——
      attach();
      fixTocTabs(mw);
      collectAnchors(mw);
      const out: HTMLElement[] = [];
      for (const s of msecs) out.push(...paginateUnit(s));
      // 记下"第 1 页长什么样"，换装时拿来比对（见 ⑥ 里的自检）。
      miniPage1Blocks = kidCount(out[0]);
      pages = out;
      singlePageMode = true;
      spread = spreadPref;
      syncMode();
      setFlow();
      // 【顺序很重要】先 updateBar 再 measure/applyZoom。
      // 「适应窗口」按 viewer 的可用高度算，而 viewer 的高度 = 窗口 − 工具栏 − 状态栏。
      // 状态栏在 updateBar 里会挂上缩放控件（多出「− 79% + 适应」那一段），
      // 它的高度和加载期间不一样 —— 实测先算缩放再建控件，视图区高度差 11px，
      // 算出来是 78% 而不是 79%，等全部排完再修正就变成「第一眼之后又缩了一下」。
      updateBar();
      measure();
      zoom = zoomPref;
      applyZoom();
      page = 1;
      paintPages();
      updateNav();
      stage.style.visibility = '';
      miniShown = true;
      miniMs = Date.now() - tBoot;
      postToHost({
        type: 'log',
        message: `Word 首屏可见：${miniMs}ms（迷你包 ${mi ? `${mi.usedBlocks}/${mi.totalBlocks}` : '?'} 块，`
          + `${mi?.atSectionEnd ? '含完整第 1 节' : '第 1 节内截断'}，`
          + `切出 ${out.length} 页（第 1 页 ${kidCount(out[0])} 块），缩放 ${stage.style.zoom || '无'}，等图 ${mReadyMs}ms）`
      });
      await paintFrame();
      if (zoom === 0) {
        const want = fitPercent();
        const now = Math.round((parseFloat(stage.style.zoom || '1') || 1) * 100);
        if (Math.abs(want - now) >= 2) applyZoom();
      }
      return true;
    } catch {
      // 这条路任何一步出岔子都退回常规流程：先把舞台清干净
      miniShown = false;
      if (host.el) { host.el.remove(); host.el = null; }
      viewer.remove();
      return false;
    }
  }

  // ===== ⑤ 整篇渲染 =====
  // 这一步是同步的（内部是不可中断的循环），耗时与文档长度成正比，没法中途让出。
  // 【v1.11·顺序关键】它**必须排在 ④.5 之后**：迷你包已经把第 1 页放出去了，
  // 用户盯着第 1 页读的这几秒里，整篇在这里渲染完。反过来放就等于白等 ——
  // 实测把这一步写在首屏之前，30MB 的文档首屏从 1.0s 退回 3.0s。
  const tRender = Date.now();
  let wrapper: HTMLElement | null = null;
  try {
    if (!miniShown) {
      opts.progress?.('正在生成页面…');
      await paintFrame();     // 先把这句提示真正画出去，再开始这段无法细分的重活
    }
    wrapper = await renderInto(input, secInfo?.dropFirstBlankPage === true);
  } catch (e) {
    styleHost.remove();
    throw e;
  }
  if (stale()) { styleHost.remove(); return null; }
  const renderMs = Date.now() - tRender;
  if (!wrapper) {
    styleHost.remove();
    throw new Error('docx-preview 没有产出页面容器');
  }

  // ===== ⑤ 后处理：等图 / 目录制表位 / 浮动元素 =====
  // 顺序不能变：图片与字体没就绪时量出来的尺寸全偏小（见 waitAssetsReady），
  // 目录折行会把页撑高好几倍（必须先修），浮动元素的占位要摘掉才能正确分页。
  //
  // 【v1.11】等待这一步不需要布局（图片 load 事件、docx-preview 的 setTimeout(500)），
  // 所以可以对着还没挂进页面的 wrapper 做 —— 迷你包已经露出第 1 页时，
  // 这一秒多就藏在「用户正在读第 1 页」的时间里。
  const queue = Array.from(wrapper.querySelectorAll(':scope > section')) as HTMLElement[];
  const headSec = queue[0] || wrapper;

  if (!miniShown) opts.progress?.('正在生成页面…');
  const assetsT0 = Date.now();
  await waitAssetsReady(headSec, 600);
  if (stale()) { styleHost.remove(); return null; }
  await waitTabStopsReady(wrapper);
  if (stale()) { styleHost.remove(); return null; }
  const assetsMs = Date.now() - assetsT0;

  // ===== ⑥ 逐节分页，切完第 1 节就先给用户看 =====
  //
  // 【为什么逐节】分页是"放进去 → 量 offsetHeight → 溢出就退回"一点点试出来的，
  // 每次 offsetHeight 都强制浏览器重排。上千页的文档整段跑完要几十秒，
  // 期间界面完全没反应。改成逐节推进 + 每节让出一帧：
  //   ① 第 1 节切完（几百毫秒）就能显示，用户不用等全文；
  //   ② 每节让出事件循环，× 按钮和 Esc 随时能关。
  //
  // 【未处理的节放 stash】stash 不挂在 document 上 ⇒ 不参与布局。
  // 文档里只留"已经切好的页 + 正在量的这一节"，单次布局成本与文档总长无关。
  // 这是 1178 页那份文档分页从 46 秒降到 1.8 秒的原因。
  const tPage = Date.now();
  paginating = true;
  let splitCount = 0;
  let firstShown = false;

  const stash = document.createElement('div');
  for (let i = 1; i < queue.length; i++) stash.appendChild(queue[i]);

  // 【v1.11·关键】已经切好的页先退出布局，最后按序一次放回。
  //
  // 分页的每一步都要读 offsetHeight，而读它会强制浏览器把"待处理的重排"全部算完。
  // 只要已切好的页还挂在容器上，这个"整树"就包含它们 —— 400 页 / 15759 段 / 1789 图
  // 的文档，越往后每量一次越贵，实测 404 页那份从 11 秒一路涨到 51 秒。
  // 移出文档后容器里只剩「当前这一节」，与文档总长无关（v1.9.6 在同一份文档上
  // 用这个办法把 1176 页的分页从 46 秒压到 1.8 秒）。
  //
  const parkPage = (el: HTMLElement): void => { el.style.contentVisibility = 'hidden'; };
  const ready: HTMLElement[] = [];
  pages = ready;

  // 整篇挂上舞台。若迷你包已经在显示第 1 页，这一步就是"换装"。
  mount(wrapper);

  // 【目录制表位 / 浮动元素】必须在**挂进页面之后**做：游离树上的 rect 全是 0，
  // 浮动图坐标会全糊到左上角。
  const toc0 = fixTocTabs(headSec);
  let tocFixed = { fixed: toc0.fixed, seen: toc0.seen };
  let anchorInfo = collectAnchors(headSec);

  let loopFrom = 0;
  if (miniShown) {
    // 【同步换装】从替换 wrapper 到重画第 1 页之间不能有 await ——
    // 有 await 浏览器就会在中间刷出一帧空白，用户看到闪一下。
    // 第 1 页的几何与迷你包完全一致，所以这一整段跑完，画面其实"没变"。
    const out = paginateUnit(queue[0]);
    // 【自检】换装前后第 1 页必须长得一模一样。
    // 一旦不一样，用户看到的就是"第 1 页自己变了一下" —— 曾经因为
    // collectAnchors 传了 section 导致浮动图没被摘出文档流，白占 385px，
    // 封面 18 个块里有 4 个被挤到第 2 页，肉眼非常明显。
    if (miniPage1Blocks >= 0 && kidCount(out[0]) !== miniPage1Blocks) {
      postToHost({
        type: 'log',
        message: `[告警] 换装后第 1 页块数变了：首屏 ${miniPage1Blocks} → 换装 ${kidCount(out[0])}`
          + `（第 1 节 ${queue[0].offsetHeight}px / 内容区 ${Math.round(pageBox(queue[0]).inner)}px）`
      });
    }
    for (const p of out) ready.push(p);
    pages = ready;
    for (let i = 1; i < out.length; i++) parkPage(out[i]);
    singlePageMode = (out.length + queue.length - 1) > 1;
    spread = spreadPref && singlePageMode;
    syncMode();
    setFlow();
    paintPages();
    updateBar();
    updateNav();
    firstShown = true;
    loopFrom = 1;
    postToHost({
      type: 'log',
      message: `Word 换装：${Date.now() - tBoot}ms（整篇渲染 ${renderMs}ms，`
        + `首屏 ${miniMs}ms 时先显示，换装后第 1 节切出 ${out.length} 页）`
    });
  }

  for (let i = loopFrom; i < queue.length; i++) {
    const sec = queue[i];
    if (i === 1) {
      // 首屏已经露出，现在补齐"其余节"的准备（首屏前只做了第 1 节，见 ⑤ 的说明）
      opts.progress?.('准备其余页面…');
      await waitTabStopsReady(wrapper);
      if (stale()) { styleHost.remove(); return null; }
      const t2 = fixTocTabs(wrapper);
      tocFixed = { fixed: tocFixed.fixed + t2.fixed, seen: tocFixed.seen + t2.seen };
      const a2 = collectAnchors(wrapper, false);
      anchorInfo = {
        floats: anchorInfo.floats + a2.floats,
        boxes: anchorInfo.boxes + a2.boxes,
        reserved: anchorInfo.reserved + a2.reserved
      };
    }
    if (i > 0) {
      // 从 stash 取回文档，单独量（迷你包已露出时 pageHost 指向整篇的 wrapper）
      host.el?.appendChild(sec);
      // 这一节的图先就绪（没有 ext 尺寸的图会撑开高度，量早了分页会切错）
      await waitAssetsReady(sec, 600);
      if (stale()) { styleHost.remove(); return null; }
    }
    const tSec = Date.now();
    const out = paginateUnit(sec);
    if (out.length > 1) splitCount++;
    // 单节超过 500ms 才记：正常文档每节几十毫秒，全记会把日志刷满；
    // 而"哪个节慢"正是分页性能回归时要看的第一条信息。
    if (Date.now() - tSec > 500) {
      postToHost({ type: 'log', message: `[分页] 第 ${i + 1}/${queue.length} 节耗时 ${Date.now() - tSec}ms，`
        + `切出 ${out.length} 页，累计 ${ready.length + out.length} 页` });
    }
    for (let k = 0; k < out.length; k++) {
      ready.push(out[k]);
      // 第 1 页留着给用户看，其余切完就退出布局（见 cutSection 的 park 说明）
      if (i === 0 && k === 0) continue;
      parkPage(out[k]);
    }

    if (!firstShown) {
      // 第 1 节已经切完 —— 第 1 页此刻就是最终形态，可以露出来了
      singlePageMode = (ready.length + (queue.length - i - 1)) > 1;
      spread = spreadPref && singlePageMode;
      syncMode();
      setFlow();
      // 【顺序很重要】先 updateBar 再 measure/applyZoom。
      // 「适应窗口」按 viewer 的可用高度算，而 viewer 的高度 = 窗口 − 工具栏 − 状态栏。
      // 状态栏在 updateBar 里会挂上缩放控件（多出「− 79% + 适应」那一段），
      // 它的高度和加载期间不一样 —— 实测先算缩放再建控件，视图区高度差 11px，
      // 算出来是 78% 而不是 79%，等全部排完再修正就变成「第一眼之后又缩了一下」。
      updateBar();
      attach();            // 舞台进页面（顺手 place 掉 .loading），此刻才有真实可用宽高
      measure();
      zoom = zoomPref;
      applyZoom();
      page = 1;
      paintPages();
      updateNav();
      stage.style.visibility = '';
      await paintFrame();          // 让这一帧真的画出去，再继续后面的重活
      // 窗口首次显示时尺寸/DPI 可能还没落定，第一次 avail() 读到的可用高度偏小，
      // 首屏就会按 77% 排、过一会儿重算成 79% —— 正是"又刷新一下"的来源之一。
      // 这里在首帧之后立刻对一次，差异很小时修正发生在同一帧内，肉眼无感。
      if (zoom === 0) {
        const want = fitPercent();
        const now = Math.round((parseFloat(stage.style.zoom || '1') || 1) * 100);
        if (Math.abs(want - now) >= 2) applyZoom();
      }
      firstShown = true;
      postToHost({
        type: 'log',
        message: `Word 首屏可见：${Date.now() - tBoot}ms（第 1 页，已排 ${ready.length} 页，`
          + `渲染 ${renderMs}ms，预处理 ${preMs}ms）`
      });
      if (stale()) { styleHost.remove(); return null; }
      continue;
    }

    opts.progress?.(`排版分页 ${i + 1}/${queue.length}（已排 ${ready.length} 页）`);
    paintPages();
    updateBar();
    updateNav();
    await yieldToUI();
    if (stale()) { styleHost.remove(); return null; }
  }

  paginating = false;

  // 分页结束：让所有页重新参与布局（content-visibility 只是分页期间的临时状态）。
  // 这一步只发生一次，是 400 页文档唯一一次大重排。
  for (const p of ready) p.style.contentVisibility = '';

  // 页数多到离谱（上千页）时才退回连续滚动：单页模式要把所有页都保持布局状态，
  // 页数太多内存和翻页开销都不划算。普通大文档（几百页）现在也能单页/双页。
  if (pages.length > MAX_PAGES_SINGLE) {
    singlePageMode = false;
    spread = false;
    setFlow();
    for (const p of pages) setPageHidden(p, false);
    syncMode();
  }

  // 分页会把段落搬到别的页，浮动元素的纸张坐标要在分页之后再落一次
  applyAnchors();

  // 页脚页码回填：必须等分页完成（页数、每页位置都定了）才能算，
  // 且要逐页做 —— 页眉页脚是每页一份副本，同一个哨兵在各页里值不同。
  // 页号口径就是「本阅读器的第几页」；Word 的 PAGE 域按自己的排版算，
  // 两边分页不完全一致时会有个位数差异，这比每页都印缓存值「第 19 页，共 19 页」好得多。
  let fieldsFilled = 0;
  for (let i = 0; i < pages.length && fillPageFieldsFn; i++) {
    fieldsFilled += fillPageFieldsFn(pages[i], i + 1, pages.length);
  }

  // 分页后第 1 页的高宽可能变了（原本被撑成好几页高的节变成标准 A4）⇒ 重算缩放。
  // 这里通常是个空操作：measure() 取的是纸高 min-height，分页前后一致。
  // 只在尺寸确实变了才动 —— 否则又会造成"第一眼之后缩放再跳一下"。
  measure();
  if (zoom === 0) {
    const want = fitPercent();
    const now = Math.round((parseFloat(stage.style.zoom || '1') || 1) * 100);
    if (Math.abs(want - now) >= 2) applyZoom();
  }
  paintPages();
  updateBar();
  updateNav();

  postToHost({
    type: 'log',
    message: `Word 结构：${pages.length} 页（含超长页 ${splitCount} 个）`
      + (tocFixed.fixed ? `，目录项修正 ${tocFixed.fixed}` : '')
      + (anchorInfo.floats ? `，浮动图片 ${anchorInfo.floats}` : '')
      + (anchorInfo.boxes ? `，文本框 ${anchorInfo.boxes}` : '')
      + (anchorInfo.reserved ? `（占位 ${anchorInfo.reserved}）` : '')
      + (secInfo ? `，页眉页脚继承 ${secInfo.inherited}${secInfo.blankFirst ? `+空白首页 ${secInfo.blankFirst}` : ''}（${secInfo.sections} 节）` : '')
      + (secInfo && secInfo.numCleared ? `，清编号 ${secInfo.numCleared}` : '')
      + (secInfo && secInfo.fields ? `，页码域 ${secInfo.fields}→回填 ${fieldsFilled}` : '')
      + (secInfo && (secInfo.emf || secInfo.emfFailed) ? `，EMF→PNG ${secInfo.emf}${secInfo.emfFailed ? `（失败 ${secInfo.emfFailed}）` : ''}` : '')
      + (secInfo?.broken?.length ? `，放弃修改的页眉页脚 ${secInfo.broken.join(',')}` : '')
      + (secInfo?.dropFirstBlankPage ? '，丢掉首段分页造的假空白页' : '')
      + pageSpan(pages)
      + `，等图 ${assetsMs}ms，分页 ${Date.now() - tPage}ms`
      + (miniShown ? `，首屏 ${miniMs}ms（迷你包先显示）` : '')
      + `，渲染 ${renderMs}ms，预处理 ${preMs}ms（${prepBreakdown(secInfo?.ms)}）`
  });

  // 一行日志带上布局数值：Word 预览一旦"只剩灰底没有内容"，几乎都是
  // 页面没查到 / 宽度算成 0 / zoom 异常，这几个数能直接定位。
  const shown = pages.filter((p) => p.style.visibility !== 'hidden').length;
  postToHost({
    type: 'log',
    message: `Word 就绪：${pageCount()} 页（${singlePageMode ? (spread ? '双页' : '单页') : '滚动'}，`
      + `适应窗口 ${fitPercent()}%，实际 ${stage.style.zoom || '无'}，`
      + `首页 ${pages[0] ? pages[0].offsetWidth + 'x' + pages[0].offsetHeight : '无'}，显示 ${shown}/${pages.length}）`
  });

  const oldDestroy = pager.destroy.bind(pager);
  pager.destroy = (): void => {
    if (ro) ro.disconnect();
    window.clearTimeout(resizeTimer);
    oldDestroy();
  };

  return pager;
}
