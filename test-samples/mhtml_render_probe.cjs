// 把 mhtml.ts 解析出的 HTML 落成独立文件，交给 Edge 无头模式截图。
// 目的：本机 WebView2 因无显卡会随机崩，无法直接看预览效果；
//      但"解析结果长什么样"可以用真实 Chromium 内核验证。
// 用法：node test-samples/mhtml_render_probe.cjs <a.mhtml> <out.html>
const fs = require('fs');
require('./.mhtml_bundle.cjs');
const parse = global.__parseMhtml;

const buf = fs.readFileSync(process.argv[2]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const { html, stats } = parse(ab);
fs.writeFileSync(process.argv[3], html, 'utf8');
console.log(JSON.stringify({ out: process.argv[3], parts: stats.parts, inlined: stats.inlined, external: stats.external, title: stats.title, chars: html.length }));
