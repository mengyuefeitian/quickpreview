// DOCX 页眉/页脚 + 重复渲染探针（jsdom + esbuild，不需要浏览器）
// 用法：node test-samples/dev_docx_hf.cjs <file.docx>
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(os.tmpdir(), `qp_hf_${Date.now()}.cjs`);

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
  console.log(`页数=${pages.length}`);
  pages.forEach((p, i) => {
    const h = p.querySelector(':scope > header');
    const f = p.querySelector(':scope > footer');
    const t = (el) => el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) : '-';
    const body = p.querySelector(':scope > article');
    console.log(`  第${i + 1}页 hdr=${h ? JSON.stringify(t(h)) : 'NONE'} ftr=${f ? JSON.stringify(t(f)) : 'NONE'} art子=${body ? body.childElementCount : '-'}`);
  });

  // 重复文本检测：同一 page 内相同文本出现多次（mc:AlternateContent 双渲染的典型症状）
  console.log('\n重复文本检测：');
  pages.forEach((p, i) => {
    const m = new Map();
    p.querySelectorAll('p, span.docx-preview-tab-stop').forEach(() => {});
    const walk = (el) => {
      for (const c of el.children) {
        if (c.tagName === 'P') {
          const txt = (c.textContent || '').trim();
          if (txt.length >= 6) m.set(txt, (m.get(txt) || 0) + 1);
        }
        walk(c);
      }
    };
    walk(p);
    const dup = Array.from(m.entries()).filter(([, n]) => n > 1);
    if (dup.length) {
      console.log(`  第${i + 1}页 重复 ${dup.length} 处：`);
      dup.slice(0, 6).forEach(([txt, n]) => console.log(`    x${n} 「${txt.slice(0, 40)}」`));
    }
  });

  // 封面元素：绝对定位/浮动框
  const sec = pages[0];
  if (sec) {
    const abs = Array.from(sec.querySelectorAll('div,span')).filter((d) => {
      const s = d.getAttribute('style') || '';
      return /position:\s*absolute/.test(s);
    });
    console.log(`\n封面绝对定位元素 ${abs.length} 个：`);
    abs.slice(0, 10).forEach((d) => {
      const s = (d.getAttribute('style') || '').replace(/\s+/g, ' ');
      console.log(`  <${d.tagName.toLowerCase()} class="${d.className}"> ${s.slice(0, 150)} 文本=${JSON.stringify((d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30))}`);
    });
  }

  fs.unlinkSync(BUNDLE);
  fs.unlinkSync(entry);
  process.exit(0);
})();
