// 导出 docx-preview 渲染结果：某页的 HTML（供人工核对结构）
// 用法：node test-samples/dev_docx_dump.cjs <file.docx> <页序号从1开始> [输出文件]
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(os.tmpdir(), `qp_dump_${Date.now()}.cjs`);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement',
  'URL', 'Blob', 'MutationObserver', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
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
  const pageNo = Number(process.argv[3] || 1);
  const outFile = process.argv[4] || '';
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const host = document.createElement('div');
  const styleHost = document.createElement('div');
  document.body.appendChild(host);
  document.body.appendChild(styleHost);
  await renderAsync(ab, host, styleHost, {
    className: 'docx-preview', inWrapper: true, ignoreWidth: false, ignoreHeight: false,
    ignoreFonts: false, breakPages: true, ignoreLastRenderedPageBreak: true,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
    experimental: true, trimXmlDeclaration: true, debug: false
  });

  const wrapper = host.querySelector('.docx-preview-wrapper');
  const pages = wrapper ? Array.from(wrapper.querySelectorAll(':scope > section')) : [];
  const sec = pages[pageNo - 1];
  const html = sec ? sec.outerHTML.replace(/></g, '>\n<') : 'NO_PAGE';
  if (outFile) fs.writeFileSync(outFile, html, 'utf-8');
  else console.log(html.slice(0, 8000));
  fs.unlinkSync(BUNDLE);
  fs.unlinkSync(entry);
  process.exit(0);
})();
