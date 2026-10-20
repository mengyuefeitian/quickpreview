// CSV 预览：按 Excel 的样子展示（表头 + 行号 + 隔行底色），
// 自动识别编码（UTF-8 / UTF-16 / GBK）与分隔符（, ; \t |）。

export interface CsvTable {
  rows: string[][];
  delimiter: string;
  delimiterName: string;
  encoding: string;
  truncated: boolean;   // 行数超过渲染上限时为 true
}

const MAX_ROWS = 3000;          // 渲染上限：再多 DOM 会卡，超出部分提示"已省略"
const DELIMS: Array<{ ch: string; name: string }> = [
  { ch: ',', name: '逗号' },
  { ch: ';', name: '分号' },
  { ch: '\t', name: '制表符' },
  { ch: '|', name: '竖线' }
];

/** 解码文本：优先 BOM，其次严格 UTF-8，再退回 GBK（国内导出的 CSV 常见 GBK）。 */
export function decodeText(ab: ArrayBuffer): { text: string; encoding: string } {
  const b = new Uint8Array(ab);

  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16 LE' };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16 BE' };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    return { text, encoding: 'UTF-8' };
  } catch { /* 不是合法 UTF-8，继续尝试 GBK */ }

  for (const enc of ['gbk', 'gb18030']) {
    try {
      const text = new TextDecoder(enc).decode(b);
      if (text) return { text, encoding: enc.toUpperCase() };
    } catch { /* 继续 */ }
  }

  return { text: new TextDecoder('windows-1252').decode(b), encoding: 'Windows-1252' };
}

/**
 * 解析分隔文本（RFC 4180）。
 * 支持双引号包裹、引号内换行、"" 转义、字段内分隔符。
 */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        cell += c;
      }
      continue;
    }

    if (c === '"' && cell.length === 0) { quoted = true; continue; }
    if (c === delim) { row.push(cell); cell = ''; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      continue;
    }
    if (c === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
      continue;
    }
    cell += c;
  }

  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }

  // 去掉末尾全空的空行
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

/** 用一个候选分隔符试解析，返回"字段数一致性"得分（越大越可信）。 */
function scoreDelimiter(text: string, delim: string): number {
  // 只看开头若干行，避免大文件整体解析两次
  let head = text;
  if (head.length > 64 * 1024) head = head.slice(0, 64 * 1024);
  const sample = parseDelimited(head, delim).slice(0, 30);
  if (!sample.length) return 0;

  const counts = new Map<number, number>();
  for (const r of sample) counts.set(r.length, (counts.get(r.length) || 0) + 1);

  let bestCount = 0;
  let bestRows = 0;
  for (const [n, k] of counts) {
    if (n > bestCount || (n === bestCount && k > bestRows)) { bestCount = n; bestRows = k; }
  }
  if (bestCount <= 1) return 0;              // 单列 → 说明不是这个分隔符
  // 一致性（多数行的列数相同）权重最高，其次才是列数
  return (bestRows / sample.length) * 100 + Math.min(bestCount, 50);
}

export function pickDelimiter(text: string): { ch: string; name: string } {
  let best = DELIMS[0];
  let bestScore = -1;
  for (const d of DELIMS) {
    const s = scoreDelimiter(text, d.ch);
    if (s > bestScore) { bestScore = s; best = d; }
  }
  return best;
}

export function readCsv(ab: ArrayBuffer): CsvTable {
  const { text, encoding } = decodeText(ab);
  const delim = pickDelimiter(text);
  const all = parseDelimited(text, delim.ch);

  const truncated = all.length > MAX_ROWS;
  const rows = truncated ? all.slice(0, MAX_ROWS) : all;

  return { rows, delimiter: delim.ch, delimiterName: delim.name, encoding, truncated };
}

const NUM_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;

/** 生成 Excel 风格的表格 DOM。 */
export function buildCsvView(t: CsvTable): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'csv-wrap';

  const meta = document.createElement('div');
  meta.className = 'csv-meta';
  const info = (label: string, value: string) => {
    const s = document.createElement('span');
    s.innerHTML = `${label} <b></b>`;
    (s.querySelector('b') as HTMLElement).textContent = value;
    return s;
  };
  meta.appendChild(info('共', `${t.rows.length} 行`));
  meta.appendChild(info('列', `${t.rows.reduce((m, r) => Math.max(m, r.length), 0)}`));
  meta.appendChild(info('分隔符', t.delimiterName));
  meta.appendChild(info('编码', t.encoding));
  if (t.truncated) {
    const s = document.createElement('span');
    s.style.color = '#c0392b';
    s.textContent = `（仅显示前 ${t.rows.length} 行）`;
    meta.appendChild(s);
  }
  wrap.appendChild(meta);

  if (!t.rows.length) {
    const empty = document.createElement('div');
    empty.className = 'csv-empty';
    empty.textContent = '（文件没有内容）';
    wrap.appendChild(empty);
    return wrap;
  }

  const cols = t.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const table = document.createElement('table');
  table.className = 'csv-grid';

  // 表头：首行 + 左上角行号列
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'rn';
  htr.appendChild(corner);
  for (let i = 0; i < cols; i++) {
    const th = document.createElement('th');
    th.textContent = (t.rows[0][i] ?? '').trim();
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 1; r < t.rows.length; r++) {
    const tr = document.createElement('tr');
    const rn = document.createElement('td');
    rn.className = 'rn';
    rn.textContent = String(r);
    tr.appendChild(rn);

    for (let i = 0; i < cols; i++) {
      const td = document.createElement('td');
      const v = t.rows[r][i] ?? '';
      td.textContent = v;
      if (v && NUM_RE.test(v.trim())) td.className = 'num';
      if (!v) td.style.background = '#fbfbfb';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}
