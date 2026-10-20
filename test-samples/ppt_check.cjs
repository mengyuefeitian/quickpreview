// PPTX 离线渲染校验（jsdom + esbuild，不需要浏览器/前台窗口）
//
// 用法：node test-samples/ppt_check.cjs <file.pptx> [更多.pptx ...]
//
// 断言：
//   1. 渲染结果里不能出现母版编辑态提示语（"Click to edit Master …"）
//      —— 母版/版式的占位符在放映和预览时不显示，画出来会盖住真实内容
//   2. 不能出现形状名（"Rounded Rectangle 11" 之类）被当文本渲染的情况
//   3. 每页都要有形状，避免"修完变成全白"
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src/renderer/lib/pptx.ts');
const BUNDLE = path.join(require('os').tmpdir(), `qp_pptx_${Date.now()}.cjs`);

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.URL = dom.window.URL;
global.Blob = dom.window.Blob;
global.performance = dom.window.performance;
// reflow/动画相关 API 在 jsdom 里缺失，给个空实现
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
if (!dom.window.URL.createObjectURL) dom.window.URL.createObjectURL = () => 'blob:mock';
if (!dom.window.URL.revokeObjectURL) dom.window.URL.revokeObjectURL = () => {};

// 渲染器对第 2 页起用 IntersectionObserver 懒渲染；jsdom 没有，不补的话只能看到第 1 页，
// 校验就会把"只有首页有形状"误判成正常。这里让所有被观察元素立刻视为进入视口。
class StubIntersectionObserver {
  constructor(cb) { this.cb = cb; }
  observe(el) { setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0); }
  unobserve() {}
  disconnect() {}
}
global.IntersectionObserver = StubIntersectionObserver;
dom.window.IntersectionObserver = StubIntersectionObserver;
global.__QP_PPT_DEBUG = !!process.env.QP_PPT_DEBUG;

const FORBIDDEN = [
  /Click to edit Master/i,
  /^Rounded Rectangle \d+$/,
  /^TextBox \d+$/,
  /^Picture \d+$/
];

(async () => {
  esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: BUNDLE,
    format: 'cjs',
    // 必须按 browser 打：JSZip 的 node 分支会 require('util') 等内置模块，
    // 在 jsdom 里跑不通。browser 分支是纯前端实现，正合预览引擎的实际运行环境。
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    logLevel: 'error'
  });
  const { renderPptx } = require(BUNDLE);

  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法：node ppt_check.cjs <file.pptx> ...');
    process.exit(2);
  }

  // 渲染器对单页失败只打 console.warn（页面里没有宿主日志通道），这里收集起来展示
  const warnings = [];
  const origWarn = console.warn.bind(console);
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  let bad = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const t0 = Date.now();
    let root;
    try {
      root = await renderPptx(ab, 960, {});
    } catch (e) {
      console.log(`[FAIL] ${path.basename(f)} 渲染抛异常：${e.message}`);
      bad++;
      continue;
    }
    const firstMs = Date.now() - t0;

    // 等懒渲染把其余页也画完（首屏耗时单独记为 firstMs，不混在一起）
    // 注意必须等 data-done，不能等 data-rendered —— 后者在开始渲染时就置位，
    // 会让我们在渲染进行中就去统计形状，误判成"大部分页空白"。
    const total = root.querySelectorAll('.slide').length;
    const tWait = Date.now();
    while (Date.now() - tWait < 60000) {
      if (root.querySelectorAll('.slide[data-done="1"]').length >= total) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const allMs = Date.now() - t0;

    const slides = root.querySelectorAll('.slide');
    const rendered = root.querySelectorAll('.slide[data-done="1"]').length;
    const shapes = root.querySelectorAll('.shape');
    const text = (root.textContent || '').replace(/\s+/g, ' ').trim();

    const hits = [];
    for (const re of FORBIDDEN) {
      const m = re.exec(text);
      if (m) hits.push(m[0]);
    }

    const problems = [];
    if (!slides.length) problems.push('没有任何幻灯片');
    if (rendered < total) problems.push(`有 ${total - rendered} 页未渲染完`);
    if (!shapes.length) problems.push('没有任何形状');
    // 母版提示语是整段出现的；只命中形状名时单独提示
    const masterHint = /Click to edit Master/i.test(text);
    if (masterHint) problems.push('出现母版占位符提示文本');
    if (hits.some((h) => !/Click to edit Master/i.test(h))) {
      problems.push('出现形状名被当文本渲染：' + hits.filter((h) => !/Click to edit Master/i.test(h)).join(', '));
    }

    if (problems.length) {
      console.log(`[FAIL] ${path.basename(f)} ${problems.join('；')}`);
      bad++;
    } else {
      console.log(
        `[PASS] ${path.basename(f)} slides=${slides.length} shapes=${shapes.length} ` +
        `首屏=${firstMs}ms 全量=${allMs}ms 文本=${text.length}字`
      );
    }
    // 抽样前 80 字便于人工核对内容是否对得上
    console.log('       文本样本：' + text.slice(0, 80));
    if (warnings.length) {
      const uniq = [...new Set(warnings)];
      console.log(`       ⚠ 渲染警告 ${uniq.length} 条：` + uniq.slice(0, 3).join(' | '));
      warnings.length = 0;
    }
    // 形状数明显偏少时逐页打印，便于定位"某几页空着"的问题
    if (shapes.length < slides.length) {
      const detail = [];
      for (let i = 0; i < Math.min(slides.length, 12); i++) {
        const s = slides[i];
        detail.push(`第${i + 1}页:${s.childElementCount}子节点/done=${s.dataset.done}`);
      }
      console.log('       ⚠ 形状偏少，逐页诊断：' + detail.join(' '));
    }
  }

  fs.unlinkSync(BUNDLE);
  process.exit(bad ? 1 : 0);
})();
