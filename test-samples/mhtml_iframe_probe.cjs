// 生成一个 wrapper.html：用与预览器完全相同的方式（iframe srcdoc + sandbox）承载解析结果，
// 交给 Edge 无头模式截图，验证"沙箱 iframe 这条渲染链路"在真实 Chromium 里可用。
// 用法：node test-samples/mhtml_iframe_probe.cjs <inlined.html> <wrapper.html>
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const wrapper = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#fff}
iframe{width:100%;height:100%;border:0;display:block;background:#fff}</style>
</head><body></body></html>`;

// 用 DOM API 方式注入 srcdoc（JSON.stringify 负责转义），与预览器代码保持一致
const inject = `
<script>
var f = document.createElement('iframe');
f.className = 'mhtml-frame';
f.setAttribute('sandbox', 'allow-scripts');
f.setAttribute('referrerpolicy', 'no-referrer');
f.srcdoc = ${JSON.stringify(html)};
document.body.appendChild(f);
</script>`;
fs.writeFileSync(process.argv[3],
  wrapper.replace('<body></body>', '<body>' + inject + '</body>'), 'utf8');
console.log(JSON.stringify({ wrapper: process.argv[3], srcdocChars: html.length }));
