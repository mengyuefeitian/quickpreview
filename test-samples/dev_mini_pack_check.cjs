// 检查首屏迷你包的真实内容（不是 info 里的数字，而是包里那份 document.xml）
// 用法：node test-samples/dev_mini_pack_check.cjs <file.docx>
const fs = require('fs'), path = require('path'), os = require('os');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(os.tmpdir(), 'qp_minicheck_' + Date.now() + '.cjs');

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

  let miniBlob = null;
  const buf = fs.readFileSync(process.argv[2]);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = await prepareDocx(ab, { onMini: async (b) => { miniBlob = b; } });

  console.log('dropFirstBlankPage =', r.info.dropFirstBlankPage);
  const m = r.info.mini;
  console.log('info.mini =', m ? { usedBlocks: m.usedBlocks, totalBlocks: m.totalBlocks, atSectionEnd: m.atSectionEnd } : null);
  if (!miniBlob) { console.log('没有迷你包'); return; }

  const mz = await JSZip.loadAsync(await miniBlob.arrayBuffer());
  const d = await mz.file('word/document.xml').async('string');
  const bodyStart = d.indexOf('<w:body>') + '<w:body>'.length;
  const pCount = (d.match(/<w:p[\s>]/g) || []).length;
  const tblCount = (d.match(/<w:tbl>/g) || []).length;
  const sectCount = (d.match(/<w:sectPr\b/g) || []).length;
  console.log(`迷你包：document.xml ${d.length} 字符，部件 ${Object.keys(mz.files).length}，`
    + `段落 ${pCount}，表格 ${tblCount}，sectPr ${sectCount}`);
  console.log('body 开头 :', JSON.stringify(d.slice(bodyStart, bodyStart + 120)));
  console.log('body 末尾 :', JSON.stringify(d.slice(-160)));
})().catch((e) => { console.error(e); process.exit(1); });
