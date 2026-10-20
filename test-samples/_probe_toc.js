const secs = Array.from(document.querySelectorAll('.docx-preview-wrapper > section'));
const stage = document.querySelector('.docx-stage');
if (stage) stage.style.zoom = '';
const s = secs[6];
const was = s.style.display; s.style.display = 'block';
const art = s.querySelector(':scope > article');
const items = Array.from(art.querySelectorAll('p')).slice(0, 12);
const out = [`section w=${s.offsetWidth} pad=${getComputedStyle(s).paddingLeft}`];
items.forEach((p, i) => {
  const head = p.querySelector('.qp-toc-head');
  const lead = p.querySelector('.qp-toc-leader');
  const num = p.querySelector('.qp-toc-num');
  out.push(`[${i}] cls=${p.className} w=${p.offsetWidth} h=${p.offsetHeight} headW=${head ? head.offsetWidth : '-'} leadW=${lead ? lead.offsetWidth : '-'} numW=${num ? num.offsetWidth : '-'} 文本「${(p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)}」`);
});
// 未修正的 toc1 长什么样
const t1 = art.querySelector('.docx-preview_toc1');
if (t1) out.push('toc1 HTML: ' + t1.outerHTML.replace(/></g, '>\n<').slice(0, 900));
s.style.display = was;
return out.join('\n');
