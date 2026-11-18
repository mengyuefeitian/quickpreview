// 离线跑 docxsec 的预处理，检查「首段分页」探测是否命中。
// 用法：node test-samples/dev_docx_firstblank_probe.cjs <file.docx> [<file2.docx> ...]
// 输出：每个文件一行 dropFirstBlankPage=... + 迷你包信息
const fs = require('fs'), path = require('path'), os = require('os');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(os.tmpdir(), 'qp_firstblank_' + Date.now() + '.cjs');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement',
  'URL', 'Blob', 'MutationObserver', 'getComputedStyle']) global[k] = dom.window[k];
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
if (!dom.window.URL.createObjectURL) dom.window.URL.createObjectURL = () => 'blob:mock';
if (!dom.window.URL.revokeObjectURL) dom.window.URL.revokeObjectURL = () => {};

(async () => {
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/renderer/lib/docxsec.ts')],
    bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'browser',
    mainFields: ['browser', 'module', 'main'], logLevel: 'error'
  });
  const { prepareDocx } = require(BUNDLE);

  for (const file of process.argv.slice(2)) {
    const buf = fs.readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const t0 = Date.now();
    let r = null;
    try {
      r = await prepareDocx(ab, {});
    } catch (e) {
      console.log(`${path.basename(file)} -> 预处理抛错 ${e.message}`);
      continue;
    }
    if (!r) { console.log(`${path.basename(file)} -> 预处理返回 null`); continue; }
    const i = r.info;
    const m = i.mini;
    console.log(`${path.basename(file)}`)
    console.log(`  dropFirstBlankPage=${i.dropFirstBlankPage}  节=${i.sections} 编号清理=${i.numCleared} 页脚域=${i.fields}`
      + `  耗时=${Date.now() - t0}ms`
      + (m ? `  迷你包 ${m.usedBlocks}/${m.totalBlocks} 块 atSectionEnd=${m.atSectionEnd}` : '  无迷你包'));
  }
})().catch((e) => { console.error(e); process.exit(1); });
