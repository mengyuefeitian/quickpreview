# -*- coding: utf-8 -*-
"""DOCX 长表格分页验证（不需要真实浏览器，也不依赖显卡）。

用法：python test-samples/dev_docx_table_test.py

背景：docx 文档里的长表格原来整块塞进一页，页面被撑成"长页"（实测 4300px，
A4 只有 1123px）。修法是按行把表拆成多张，跟着分页走。

jsdom 没有布局，所以这里用 data-h 属性给元素喂"假高度"，
确定性地验证拆分点、列宽/表头复制、以及不丢行。
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join("test-samples", "docx_table_entry.ts")
BUNDLE = os.path.join("test-samples", ".docxtable_bundle.cjs")
RUNNER = os.path.join("test-samples", ".docxtable_run.cjs")

RUNNER_SRC = r"""
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');

// jsdom 不做布局：用 data-h 喂假高度。
// 表格特殊处理 —— 按行数推算（每行 50px），这样拆表之后每段的"高度"会自动变小，
// 和真实浏览器一致；否则拆出来的段还带着原始整表高度，分页判断会被带偏。
const ROW_H = 50;
dom.window.Element.prototype.getBoundingClientRect = function () {
  let h = Number(this.getAttribute && this.getAttribute('data-h')) || 0;
  if (this.tagName === 'TABLE' && this.rows) h = this.rows.length * ROW_H;
  return { height: h, width: 600, top: 0, left: 0, right: 600, bottom: h, x: 0, y: 0 };
};

global.window = dom.window;
global.document = dom.window.document;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.requestAnimationFrame = () => 0;

require('./.docxtable_bundle.cjs');
const splitTable = global.__splitTableByRows;
const cutSection = global.__cutSection;

const doc = dom.window.document;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

function mkTable(rows, rowH, withHead, cols) {
  const t = doc.createElement('table');
  const cg = doc.createElement('colgroup');
  for (let i = 0; i < (cols || 2); i++) {
    const c = doc.createElement('col');
    c.setAttribute('style', 'width:' + (100 + i * 50) + 'px');
    cg.appendChild(c);
  }
  t.appendChild(cg);
  if (withHead) {
    const th = doc.createElement('thead');
    const tr = doc.createElement('tr');
    tr.setAttribute('data-h', String(rowH));
    tr.innerHTML = '<td>表头A</td><td>表头B</td>';
    th.appendChild(tr);
    t.appendChild(th);
  }
  for (let i = 0; i < rows; i++) {
    const tr = doc.createElement('tr');
    tr.setAttribute('data-h', String(rowH));
    tr.innerHTML = '<td>r' + i + '</td><td>v</td>';
    t.appendChild(tr);
  }
  return t;
}

// ---------- 1. 普通表格按行拆 ----------
{
  const t = mkTable(20, 50, false);
  doc.body.appendChild(t);
  const parts = splitTable(t, 300, 600);
  const counts = parts.map((p) => p.rows.length);
  check('20 行按 300/600 拆', parts.length === 3 && counts.join() === '6,12,2',
    '段数 ' + parts.length + '，各段行数 ' + counts.join('/'));
  check('拆分后不丢行', counts.reduce((a, b) => a + b, 0) === 20, '合计 ' + counts.reduce((a, b) => a + b, 0));
  check('每段都有 colgroup', parts.every((p) => !!p.querySelector('colgroup')),
    parts.map((p) => (p.querySelector('colgroup') ? '有' : '无')).join('/'));
  const widths = parts[1].querySelectorAll('col');
  check('列宽被复制', widths.length === 2 && widths[1].getAttribute('style').indexOf('150px') >= 0,
    Array.from(widths).map((c) => c.getAttribute('style')).join(' | '));
}

// ---------- 2. 表头（thead）每段重复 ----------
{
  const t = mkTable(18, 50, true);
  doc.body.appendChild(t);
  const parts = splitTable(t, 300, 600);
  const heads = parts.map((p) => (p.tHead ? p.tHead.rows.length : 0));
  const counts = parts.map((p) => p.rows.length);
  check('带表头的表拆分', parts.length === 2 && heads.every((h) => h === 1),
    '段数 ' + parts.length + '，各段 thead 行数 ' + heads.join('/'));
  // 18 行数据拆成 6 + 12；每段再各带 1 行表头 ⇒ 7 / 13
  check('表头不计入数据行', counts.join() === '7,13', '各段总行数 ' + counts.join('/'));
}

// ---------- 3. cutSection：长表格跟着页面走 ----------
{
  const sec = doc.createElement('section');
  sec.className = 'docx-preview';
  sec.setAttribute('style', 'min-height:1122.5px;padding:96px');
  sec.setAttribute('data-h', '1122');
  const art = doc.createElement('article');
  const p1 = doc.createElement('p');
  p1.setAttribute('data-h', '200');
  p1.textContent = '标题';
  const t = mkTable(40, 50, false);
  t.setAttribute('data-h', '2000');
  const p2 = doc.createElement('p');
  p2.setAttribute('data-h', '100');
  art.appendChild(p1); art.appendChild(t); art.appendChild(p2);
  sec.appendChild(art);
  doc.body.appendChild(sec);

  const made = cutSection(sec, 930);
  const pages = [sec, ...made];
  const layout = pages.map((pg) => {
    const a = pg.querySelector('article');
    return Array.from(a.children).map((c) =>
      c.tagName === 'TABLE' ? 'T' + c.rows.length : (c.textContent || c.tagName).slice(0, 4));
  });
  check('长表格被拆到多页', pages.length > 1 && layout[0].some((x) => x[0] === 'T'),
    '共 ' + pages.length + ' 页：' + JSON.stringify(layout));
  const totalRows = pages.reduce((n, pg) => n + Array.from(pg.querySelectorAll('table')).reduce((m, x) => m + x.rows.length, 0), 0);
  check('分页后行数不丢', totalRows === 40, '合计 ' + totalRows + ' 行');
  const bigT = Array.from(sec.querySelectorAll('table')).some((x) => x.rows.length > 20);
  check('没有整块塞在一页的长表格', !bigT, bigT ? '仍有一页装了 >20 行' : '每页行数已受控');
}

// ---------- 4. 剩余空间不足三成 → 整表换页，不拆出碎页 ----------
{
  const sec = doc.createElement('section');
  sec.className = 'docx-preview';
  sec.setAttribute('style', 'min-height:1122.5px;padding:96px');
  const art = doc.createElement('article');
  const p1 = doc.createElement('p');
  p1.setAttribute('data-h', '800');
  p1.textContent = '大段落';
  const t = mkTable(40, 50, false);
  t.setAttribute('data-h', '2000');
  art.appendChild(p1); art.appendChild(t);
  sec.appendChild(art);
  doc.body.appendChild(sec);

  const made = cutSection(sec, 930);
  const pages = [sec, ...made];
  const rowCounts = pages.map((pg) => Array.from(pg.querySelectorAll('table')).reduce((m, x) => m + x.rows.length, 0));
  // 最后一段是表格自然收尾的尾巴（40 = 18+18+4），不要求它填满
  check('剩余不足三成时不硬拆', rowCounts.slice(0, -1).every((n) => n === 0 || n >= 10),
    '各页表格行数 ' + rowCounts.join('/'));
  check('段落独占第一页', rowCounts[0] === 0, '第一页表格行数 ' + rowCounts[0]);
}

// ---------- 5. 单行就超页：仍能拆，允许溢出 ----------
{
  const t = mkTable(3, 500, false);
  doc.body.appendChild(t);
  const parts = splitTable(t, 930, 930);
  check('单行超高也能拆', parts.length === 3 && parts.every((p) => p.rows.length === 1),
    '段数 ' + parts.length + '，各段行数 ' + parts.map((p) => p.rows.length).join('/'));
}

// ---------- 6. 非表格的超页块不受影响 ----------
{
  const sec = doc.createElement('section');
  sec.className = 'docx-preview';
  sec.setAttribute('style', 'min-height:1122.5px;padding:96px');
  const art = doc.createElement('article');
  const p1 = doc.createElement('p');
  p1.setAttribute('data-h', '2000');
  p1.textContent = '超页段落';
  art.appendChild(p1);
  sec.appendChild(art);
  doc.body.appendChild(sec);
  const made = cutSection(sec, 930);
  check('超页段落不被误拆', made.length === 0, '新建页数 ' + made.length);
}

console.log(JSON.stringify(results));
"""


def main():
    with open(os.path.join(ROOT, RUNNER), "w", encoding="utf-8") as f:
        f.write(RUNNER_SRC)

    r = subprocess.run(
        "npx esbuild " + ENTRY + " --bundle --format=cjs --outfile=" + BUNDLE
        + " --platform=node --target=node18 --log-level=error",
        cwd=ROOT, capture_output=True, text=True, shell=True
    )
    if r.returncode != 0:
        print("esbuild 打包失败：\n" + (r.stderr or r.stdout)[:600])
        return 2

    r = subprocess.run(["node", os.path.basename(RUNNER)],
                       cwd=os.path.join(ROOT, "test-samples"),
                       capture_output=True, text=True, shell=True)
    try:
        results = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        print("runner 输出无法解析：\n" + (r.stdout or "")[:600] + (r.stderr or "")[:600])
        return 2

    bad = 0
    for x in results:
        if not x["ok"]:
            bad += 1
        print("%s %s  —— %s" % ("√" if x["ok"] else "×", x["name"], x["detail"]))

    for p in (BUNDLE, RUNNER):
        fp = os.path.join(ROOT, p)
        if os.path.exists(fp):
            os.remove(fp)

    print()
    print("全部通过" if bad == 0 else "有 %d 项失败" % bad)
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
