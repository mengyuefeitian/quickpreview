// 离线校验 PPTX 渲染结果（jsdom）：检查背景图片、形状数量、懒渲染是否覆盖到页。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Element = dom.window.Element;
global.Blob = global.Blob || require('buffer').Blob;
// jsdom 没有 object URL，打个桩即可验证"是否走了 blob URL 通路"
let urlSeq = 0;
dom.window.URL.createObjectURL = () => 'blob:fake-' + (++urlSeq);
dom.window.URL.revokeObjectURL = () => {};

const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'lib', 'pptx.ts')],
  bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(__dirname, '_pptx_check.js')
});

const { renderPptx } = require('./_pptx_check.js');

(async () => {
  const files = process.argv.slice(2);
  for (const f of files) {
    const ab = fs.readFileSync(f);
    const t0 = Date.now();
    const el = await renderPptx(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength), 960);
    const firstMs = Date.now() - t0;
    const slides = el.querySelectorAll('.slide');
    // 等懒渲染跑完（jsdom 无 IO，走顺序兜底）
    await new Promise((r) => setTimeout(r, 4000));

    let withBgImg = 0, withBgColor = 0, shapes = 0, imgs = 0;
    slides.forEach((s) => {
      if (s.style.backgroundImage) withBgImg++;
      if (s.style.backgroundColor || s.style.background) withBgColor++;
      shapes += s.querySelectorAll('.shape').length;
      imgs += s.querySelectorAll('img').length;
    });
    console.log(JSON.stringify({
      file: path.basename(f).slice(0, 40),
      slides: slides.length,
      firstSlideMs: firstMs,
      withBgImage: withBgImg,
      withBgColor,
      shapes,
      imgs,
      sampleBg: slides[0] ? slides[0].style.backgroundImage.slice(0, 40) : ''
    }));
  }
})();
