// DOCX 离线结构探针（jsdom + esbuild，不需要浏览器）
//
// 用法：node test-samples/dev_docx_probe.cjs <file.docx> [关键字]
//
// 输出：
//   · docx-preview 切出的页数、每页子节点数
//   · 目录（TOC）相关的段落 HTML —— 用于核对「目录解析有误」到底是
//     标题缺失、制表位丢失，还是页码域没渲染
//   · 指定关键字所在段落的 HTML（第 2 个参数）
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(os.tmpdir(), `qp_docx_${Date.now()}.cjs`);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement',
  'URL', 'Blob', 'MutationObserver', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
// 注意：不要覆盖 global.performance —— jsdom 的 Performance.now 内部又调 performance.now，
// 覆盖成 jsdom 自己的实例会无限递归（RangeError: Maximum call stack size exceeded）。
// docx-preview 处理 VML 图片时会在 rAF 里调 getBBox()，jsdom 没实现也不可能有真实布局，
// 探针只看结构，直接让回调不执行即可。
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
if (!dom.window.URL.createObjectURL) dom.window.URL.createObjectURL = () => 'blob:mock';
if (!dom.window.URL.revokeObjectURL) dom.window.URL.revokeObjectURL = () => {};

(async () => {
  const entry = path.join(ROOT, 'src/renderer/lib/docxprobe.ts');
  fs.writeFileSync(entry, `export { renderAsync } from 'docx-preview';\n`, 'utf-8');
  esbuild.buildSync({
    entryPoints: [entry], bundle: true, outfile: BUNDLE, format: 'cjs',
    platform: 'browser', mainFields: ['browser', 'module', 'main'], logLevel: 'error'
  });
  const { renderAsync } = require(BUNDLE);

  const file = process.argv[2];
  const keyword = process.argv[3] || '';
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const host = document.createElement('div');
  const styleHost = document.createElement('div');
  document.body.appendChild(host);
  document.body.appendChild(styleHost);
  const t0 = Date.now();
  await renderAsync(ab, host, styleHost, {
    className: 'docx-preview', inWrapper: true, ignoreWidth: false, ignoreHeight: false,
    ignoreFonts: false, breakPages: true, ignoreLastRenderedPageBreak: true,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
    experimental: true, trimXmlDeclaration: true, debug: false
  });
  const ms = Date.now() - t0;

  const wrapper = host.querySelector('.docx-preview-wrapper');
  const pages = wrapper ? Array.from(wrapper.querySelectorAll(':scope > section')) : [];
  console.log(`渲染耗时 ${ms}ms  页数=${pages.length}  wrapper=${wrapper ? '有' : '无'}`);
  pages.forEach((p, i) => {
    const txt = (p.textContent || '').replace(/\s+/g, ' ').trim();
    console.log(`  第${i + 1}页 子节点=${p.childElementCount} 文本=${txt.length}字 开头=${txt.slice(0, 40)}`);
  });

  // 目录段落：找带 dot leader 的 tab 或含 PAGEREF 结果的段落
  const paras = Array.from(host.querySelectorAll('p'));
  const toc = paras.filter((p) => {
    const s = p.getAttribute('style') || '';
    return /tab-stops|border-bottom|dotted/i.test(s) || /[\u2026]{2,}|\.{4,}/.test(p.textContent || '');
  });
  console.log(`\n疑似目录段落 ${toc.length} 条，前 4 条 HTML：`);
  toc.slice(0, 4).forEach((p, i) => {
    console.log(`--- [${i}] ${(p.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
    console.log(p.outerHTML.replace(/></g, '>\n<').slice(0, 1400));
  });

  if (keyword) {
    const hit = paras.filter((p) => (p.textContent || '').includes(keyword));
    console.log(`\n含「${keyword}」的段落 ${hit.length} 条，前 2 条 HTML：`);
    hit.slice(0, 2).forEach((p, i) => {
      console.log(`--- [${i}]`);
      console.log(p.outerHTML.replace(/></g, '>\n<').slice(0, 1600));
    });
  }

  // 注入的样式表里和 tab / 目录有关的规则
  const css = Array.from(styleHost.querySelectorAll('style')).map((s) => s.textContent).join('\n');
  const rules = css.split('}').filter((r) => /tab|toc|dotted|leader/i.test(r));
  console.log(`\n样式表中 tab/toc 相关规则 ${rules.length} 条：`);
  rules.slice(0, 8).forEach((r) => console.log('  ' + r.trim().replace(/\s+/g, ' ').slice(0, 200) + ' }'));

  fs.unlinkSync(BUNDLE);
  fs.unlinkSync(entry);
  process.exit(0);
})();
