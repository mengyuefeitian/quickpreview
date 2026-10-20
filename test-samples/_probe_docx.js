const secs = Array.from(document.querySelectorAll('.docx-preview-wrapper > section'));
const out = [];
out.push('sections=' + secs.length);
out.push('bar=' + (document.querySelector('.preview-bar')?.innerText || '').replace(/\n/g, ' | '));
secs.forEach((s, i) => {
  const h = s.querySelector(':scope > header');
  const f = s.querySelector(':scope > footer');
  const art = s.querySelector(':scope > article');
  const r = s.getBoundingClientRect();
  const txt = (s.innerText || '').replace(/\s+/g, ' ').slice(0, 50);
  out.push(`#${i + 1} ${Math.round(r.width)}x${Math.round(s.offsetHeight)} hdr=${h ? Math.round(h.offsetHeight) + 'px/' + (h.innerText || '').replace(/\s+/g, ' ').slice(0, 20) : 'NONE'} ftr=${f ? Math.round(f.offsetHeight) + 'px/' + (f.innerText || '').replace(/\s+/g, ' ').slice(0, 25) : 'NONE'} art=${art ? art.children.length : '-'} disp=${s.style.display || 'block'} 「${txt}」`);
});
return out.join('\n');
