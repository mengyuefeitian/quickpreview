// Markdown 渲染（.md / .mkd / .markdown）
//
// 以前 md 归在 text 类别里，直接丢进 <pre> 按等宽文本显示 —— 用户看到的是带
// `#`、`**`、`|` 的原始文件，等于没预览。这里把它按 Markdown 语义渲染成排版后的正文。
//
// 为什么自己写解析器而不引 marked / markdown-it：
//   ① 这是预览器，只需要「读」的语义，不需要 CommonMark 全部边角（引用式链接、
//      嵌套强调的 30 多种歧义组合等）；② 多一个 ~40KB 依赖就多一份升级与供应链负担，
//      项目其余重型库都是按需动态 import 的，首屏包越干净越好。
//
// 安全：Markdown 里的原始 HTML **一律转义**，不解析、不插入 DOM。
// 预览一个来路不明的 md 不该有执行脚本的机会；链接与图片地址也做协议白名单。
import { appLocalUrl, el } from './util';
import { postToHost } from './host';

/** 单个文件最多渲染这么多字节；再大就截断并提示（md 极少超过 1MB） */
const MAX_BYTES = 8 * 1024 * 1024;

export interface MarkdownViewerOptions {
  /** 文件所在目录，用于解析相对路径图片 */
  baseDir: string;
  stale: () => boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** 相对路径 → 本地文件地址（宿主拦截 __local 读取）。绝对 URL / data: 原样返回。 */
function resolveUrl(raw: string, baseDir: string): string | null {
  const u = raw.trim();
  if (!u) return null;
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null;          // javascript: / file: 等一律拒绝
  if (u.startsWith('#') || u.startsWith('//')) return u.startsWith('//') ? 'https:' + u : null;
  const decoded = (() => { try { return decodeURIComponent(u); } catch { return u; } })();
  const sep = baseDir.includes('\\') ? '\\' : '/';
  const joined = /^[\\/]/.test(decoded) ? decoded : baseDir.replace(/[\\/]+$/, '') + sep + decoded;
  // markdown 里写 ./img/a.png、a.png 都按"相对当前 md 的目录"处理
  return appLocalUrl(joined.replace(/[\\/]/g, sep));
}

// ---------------------------------------------------------------------------
// 行内元素
// ---------------------------------------------------------------------------

const CODE_MARK = '\u0000';

/** 行内渲染：代码 → 图片 → 链接 → 粗体/斜体/删除线 → 自动链接 */
function inline(src: string, baseDir: string): string {
  // 先把反斜杠转义的保护字符换成占位符，避免 \* 被当成强调
  const esc: string[] = [];
  let s = src.replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, (_m, ch: string) => {
    esc.push(ch);
    return `\u0001${esc.length - 1}\u0001`;
  });

  s = escapeHtml(s);

  // ① 行内代码：内容不再参与任何后续替换，先摘出来
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
  });

  // ② 图片 ![alt](src "title")  ③ 链接 [text](href "title")
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
    (_m, alt: string, href: string, title?: string) => {
      const url = resolveUrl(href, baseDir);
      if (!url) return alt;
      const t = title ? ` title="${title}"` : '';
      return `<img class="md-img" src="${url}" alt="${alt}"${t}>`;
    });

  s = s.replace(/\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
    (_m, text: string, href: string, title?: string) => {
      const url = resolveUrl(href, baseDir);
      if (!url) return text;
      const t = title ? ` title="${title}"` : '';
      return `<a class="md-link" href="${url}"${t} target="_blank" rel="noreferrer">${text}</a>`;
    });

  // ④ 强调。先长后短，避免 ** 被单个 * 抢走
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w_])__([^_]+)__/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // ⑤ 裸链接（http/https），跳过已在 <a> 里的
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()"'）]+)/g,
    (_m, pre: string, url: string) => `${pre}<a class="md-link" href="${url}" target="_blank" rel="noreferrer">${url}</a>`);

  // ⑥ 行尾两个空格 → 硬换行
  s = s.replace(/ {2,}\n/g, '<br>\n');

  // 还原行内代码（内容也要转义，`<b>` 就该显示成 <b>）
  s = s.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'),
    (_m, i: string) => `<code class="md-code">${escapeHtml(codes[Number(i)])}</code>`);
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => escapeHtml(esc[Number(i)]));
  return s;
}

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

type Line = string;

const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const RE_HEADING = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?/;
const RE_UL = /^(\s*)([-*+])\s+(.*)$/;
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isBlank(l: Line): boolean {
  return !l.trim();
}

/** 判断某行会不会开启一个新块（用于结束段落） */
function startsBlock(l: Line): boolean {
  return RE_FENCE.test(l) || RE_HEADING.test(l) || RE_HR.test(l) || RE_QUOTE.test(l)
    || RE_UL.test(l) || RE_OL.test(l);
}

function splitTableRow(l: Line): string[] {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // 支持 \| 转义的竖线
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(sep: Line): string | null {
  const s = sep.trim().replace(/^\||\|$/g, '').split('|')[0] || '';
  const l = s.trim().startsWith(':');
  const r = s.trim().endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return null;
}

/**
 * 解析一段连续的行，返回块级 DOM 节点。
 * 列表与引用递归调用自身，缩进 2 空格以上视为子列表。
 */
function parseBlocks(lines: Line[], baseDir: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i++; continue; }

    // 代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const mark = fence[2];
      const lang = fence[3] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;   // 跳过结束围栏（缺失也能正常结束）
      const pre = document.createElement('pre');
      pre.className = 'md-pre';
      if (lang) {
        const tag = document.createElement('span');
        tag.className = 'md-lang';
        tag.textContent = lang;
        pre.appendChild(tag);
      }
      const code = document.createElement('code');
      code.textContent = body.join('\n');
      pre.appendChild(code);
      out.push(pre);
      continue;
    }

    // 分隔线
    if (RE_HR.test(line)) {
      const hr = document.createElement('hr');
      hr.className = 'md-hr';
      out.push(hr);
      i++;
      continue;
    }

    // 标题
    const h = RE_HEADING.exec(line);
    if (h) {
      const lv = h[2].length;
      const node = document.createElement(`h${lv}`) as HTMLElement;
      node.className = `md-h md-h${lv}`;
      node.innerHTML = inline(h[3], baseDir);
      out.push(node);
      i++;
      continue;
    }

    // 引用：整段连续的 > 行交给递归
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || (!isBlank(lines[i]) && inner.length))) {
        inner.push(lines[i].replace(RE_QUOTE, ''));
        i++;
      }
      const bq = document.createElement('blockquote');
      bq.className = 'md-quote';
      for (const n of parseBlocks(inner, baseDir)) bq.appendChild(n);
      out.push(bq);
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const tbl = document.createElement('table');
      tbl.className = 'md-table';
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      head.forEach((c, k) => {
        const th = document.createElement('th');
        th.innerHTML = inline(c, baseDir);
        if (aligns[k]) th.style.textAlign = aligns[k] as string;
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      tbl.appendChild(thead);
      const tb = document.createElement('tbody');
      for (const r of rows) {
        const tr = document.createElement('tr');
        for (let k = 0; k < head.length; k++) {
          const td = document.createElement('td');
          td.innerHTML = inline(r[k] || '', baseDir);
          if (aligns[k]) td.style.textAlign = aligns[k] as string;
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      out.push(tbl);
      continue;
    }

    // 列表（有序 / 无序 / 任务）
    const ul = RE_UL.exec(line);
    const ol = RE_OL.exec(line);
    if (ul || ol) {
      const ordered = !!ol && !ul;
      const baseIndent = (ol ? ol[1] : ul![1]).replace(/\t/g, '  ').length;
      const list = document.createElement(ordered ? 'ol' : 'ul') as HTMLElement;
      list.className = ordered ? 'md-ol' : 'md-ul';
      if (ordered) list.setAttribute('start', (ol as RegExpExecArray)[2]);

      while (i < lines.length) {
        const l = lines[i];
        const m = ordered ? RE_OL.exec(l) : RE_UL.exec(l);
        if (!m) {
          // 列表项的续行（缩进且不是新块）归到上一项
          if (!isBlank(l) && /^\s{2,}/.test(l) && !startsBlock(l)) {
            const lastLi = list.lastElementChild as HTMLElement | null;
            if (lastLi) { lastLi.innerHTML += '<br>' + inline(l.trim(), baseDir); i++; continue; }
          }
          break;
        }
        const indent = m[1].replace(/\t/g, '  ').length;
        if (indent < baseIndent) break;
        if (indent > baseIndent) {
          // 更深的缩进 ⇒ 子列表，递归吃到这里为止
          const sub: string[] = [];
          while (i < lines.length) {
            const l2 = lines[i];
            const m2 = ordered ? RE_OL.exec(l2) : RE_UL.exec(l2);
            const ind2 = m2 ? m2[1].replace(/\t/g, '  ').length : 0;
            if (isBlank(l2)) break;
            if (!m2 && !/^\s{2,}/.test(l2)) break;
            if (m2 && ind2 <= baseIndent) break;
            sub.push(l2);
            i++;
          }
          const lastLi = list.lastElementChild as HTMLElement | null;
          const children = parseBlocks(sub, baseDir);
          if (lastLi) {
            for (const c of children) lastLi.appendChild(c);
          } else {
            for (const c of children) list.appendChild(c);
          }
          continue;
        }

        let text = m[3];
        const li = document.createElement('li');
        li.className = 'md-li';
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (task) {
          const done = task[1].toLowerCase() === 'x';
          li.classList.add('md-task');
          const box = document.createElement('span');
          box.className = 'md-check' + (done ? ' done' : '');
          box.textContent = done ? '✓' : '';
          li.appendChild(box);
          const span = document.createElement('span');
          span.innerHTML = inline(task[2], baseDir);
          li.appendChild(span);
        } else {
          li.innerHTML = inline(text, baseDir);
        }
        list.appendChild(li);
        i++;
      }
      out.push(list);
      continue;
    }

    // 段落：吃到空行或下一个块的开始
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) {
      para.push(lines[i]);
      i++;
    }
    const p = document.createElement('p');
    p.className = 'md-p';
    p.innerHTML = inline(para.join('\n'), baseDir);
    out.push(p);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function humanSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export async function renderMarkdownViewer(
  path: string, body: HTMLElement, bar: HTMLElement, opts: MarkdownViewerOptions
): Promise<void> {
  const t0 = Date.now();
  const res = await fetch(appLocalUrl(path));
  if (opts.stale()) return;
  if (!res.ok) throw new Error('HTTP ' + res.status);

  let buf = await res.arrayBuffer();
  if (opts.stale()) return;
  const total = buf.byteLength;
  let truncated = false;
  if (total > MAX_BYTES) {
    buf = buf.slice(0, MAX_BYTES);
    truncated = true;
  }

  // 编码：UTF-8 优先；有 BOM 就直接按 UTF-8（TextDecoder 会自己吃掉 BOM）。
  // 中文环境里 GBK 的 md 不少见，先用 fatal 模式试严格 UTF-8，失败再退 GBK。
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      text = new TextDecoder('utf-8').decode(buf);
    }
  }
  // 统一换行，去掉 BOM 残留
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  const baseDir = path.replace(/[\\/][^\\/]*$/, '');
  const root = el('div', 'md-view');
  const inner = el('div', 'md-body');
  root.appendChild(inner);

  const lines = text.split('\n');
  for (const node of parseBlocks(lines, baseDir)) inner.appendChild(node);
  if (truncated) {
    inner.appendChild(el('p', 'md-truncated',
      `（文件较大，只渲染了前 ${humanSize(MAX_BYTES)}，完整内容共 ${humanSize(total)}）`));
  }

  if (opts.stale()) return;
  body.innerHTML = '';
  body.appendChild(root);

  // 右下角给个字数/标题数，比只有"Markdown"更有信息量
  const headings = inner.querySelectorAll('.md-h').length;
  const words = (text.match(/[A-Za-z0-9]+|[\u4e00-\u9fa5]/g) || []).length;
  const nameEl = bar.querySelector('.pb-name');
  const name = nameEl ? nameEl.textContent || '' : '';
  bar.innerHTML = '';
  const s1 = el('span', 'pb-name', name);
  const s2 = el('span', '');
  s2.textContent = `Markdown · ${headings} 个标题 · 约 ${words} 字 · ${humanSize(total)}`;
  bar.appendChild(s1);
  bar.appendChild(s2);

  postToHost({
    type: 'log',
    message: `Markdown 渲染完成：${path}（${lines.length} 行，${headings} 个标题，${Date.now() - t0} ms`
      + `${truncated ? '，已截断' : ''}）`
  });
}
