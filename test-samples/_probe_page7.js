const secs = Array.from(document.querySelectorAll('.docx-preview-wrapper > section'));
const stage = document.querySelector('.docx-stage');
if (stage) stage.style.zoom = '';     // 清掉缩放，否则 offsetHeight / rect 混着看会错
const s = secs[Number('__PAGE__') - 1] || secs[0];
const was = s.style.display; s.style.display = 'block';
const cs = getComputedStyle(s);
const art = s.querySelector(':scope > article');
const acs = getComputedStyle(art);
const kids = Array.from(art.children);
const sum = kids.reduce((a, k) => a + k.offsetHeight, 0);
const lines = [
  `section offsetH=${s.offsetHeight} minH=${cs.minHeight} pad=${cs.paddingTop}/${cs.paddingBottom}`,
  `article offsetH=${art.offsetHeight} scrollH=${art.scrollHeight} 子节点高度合计=${sum} display=${acs.display} position=${acs.position}`,
  `子节点 ${kids.length} 个：`
];
kids.forEach((k, i) => {
  const r = k.getBoundingClientRect();
  const st = getComputedStyle(k);
  lines.push(`  [${i}] ${k.tagName} h=${Math.round(r.height)} mt=${st.marginTop} mb=${st.marginBottom} cls=${k.className} 「${(k.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)}」`);
});
s.style.display = was;
return lines.join('\n');
