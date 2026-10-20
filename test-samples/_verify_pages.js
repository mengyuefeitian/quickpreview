const secs = Array.from(document.querySelectorAll('.docx-preview-wrapper > section'));
const rows = [];
let bad = 0;
secs.forEach((s, i) => {
  // 临时显示才能量到真实尺寸
  const was = s.style.display;
  s.style.display = 'block';
  const cs = getComputedStyle(s);
  const pageH = parseFloat(cs.minHeight) || s.offsetHeight;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const art = s.querySelector(':scope > article');
  const h = s.querySelector(':scope > header');
  const f = s.querySelector(':scope > footer');
  const artH = art ? art.offsetHeight : 0;
  const inner = pageH - padT - padB;
  const over = artH - inner;
  const hT = h ? (h.innerText || '').replace(/\s+/g, ' ').trim() : '';
  const fT = f ? (f.innerText || '').replace(/\s+/g, ' ').trim() : '';
  const flags = [];
  if (Math.abs(pageH - 1123) > 2) flags.push(`页高${Math.round(pageH)}`);
  if (over > 2) flags.push(`溢出${Math.round(over)}px`);
  if (i > 0 && !hT) flags.push('缺页眉');
  if (i > 0 && !fT) flags.push('缺页脚');
  if (i === 0 && (hT || fT)) flags.push('封面有页眉页脚');
  if (flags.length) { bad++; rows.push(`#${i + 1} ${Math.round(s.offsetWidth)}x${Math.round(pageH)} ${flags.join(',')}`); }
  s.style.display = was;
});
return `共 ${secs.length} 页，异常 ${bad} 页` + (bad ? '\n' + rows.join('\n') : '');
