const secs = Array.from(document.querySelectorAll('.docx-preview-wrapper > section'));
const noH = [], noF = [], blanks = [];
secs.forEach((s, i) => {
  const was = s.style.display; s.style.display = 'block';
  const h = s.querySelector(':scope > header');
  const f = s.querySelector(':scope > footer');
  const ht = h ? (h.innerText || '').replace(/\s+/g, ' ').trim() : '';
  const ft = f ? (f.innerText || '').replace(/\s+/g, ' ').trim() : '';
  if (!h) noH.push(i + 1);
  if (!f) noF.push(i + 1);
  if (h && !ht && i > 0) blanks.push(i + 1);
  s.style.display = was;
});
const lim = (a) => a.length > 8 ? a.slice(0, 8).join(',') + `…（共${a.length}）` : a.join(',');
return `共 ${secs.length} 页｜缺页眉元素：${noH.length ? lim(noH) : '无'}｜缺页脚元素：${noF.length ? lim(noF) : '无'}｜首页之外页眉为空白：${blanks.length ? lim(blanks) : '无'}`;
