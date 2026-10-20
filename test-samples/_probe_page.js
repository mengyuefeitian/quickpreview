const n = Number('__PAGE__') || 2;
// 翻到第 n 页：点下一页按钮 n-1 次
for (let i = 1; i < n; i++) {
  document.querySelector('.pdf-next')?.click();
}
await new Promise((r) => setTimeout(r, 500));
const bar = document.querySelector('.preview-bar')?.innerText.replace(/\n/g, ' ') || '';
const v = document.querySelector('.docx-viewer');
const secs = Array.from(document.querySelectorAll('.docx-preview-wrapper > section'));
const vis = secs.find((s) => s.style.display !== 'none');
const h = vis?.querySelector(':scope > header');
const f = vis?.querySelector(':scope > footer');
const rect = (el) => el ? `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}` : '-';
const t = (el) => el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '-';
return `${bar}\n当前页=${secs.indexOf(vis) + 1}/${secs.length} 页尺寸=${rect(vis)} 页眉=${rect(h)}「${t(h)}」 页脚=${rect(f)}「${t(f)}」 scrollTop=${v?.scrollTop}`;
