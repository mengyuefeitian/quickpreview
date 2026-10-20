const secs = Array.from(document.querySelectorAll('.docx-preview-wrapper > section'));
const stage = document.querySelector('.docx-stage');
if (stage) stage.style.zoom = '';
const s = secs[6];
const was = s.style.display; s.style.display = 'block';
const p = s.querySelector('p.qp-toc-item');
const a = p.querySelector('a');
const sp = p.querySelector('.qp-toc-head span');
const info = (el, name) => {
  if (!el) return `${name}: 无`;
  const cs = getComputedStyle(el);
  return `${name}: color=${cs.color} decoration=${cs.textDecorationLine} tag=${el.tagName} class=${el.className || '-'}`;
};
const out = [info(p, 'p'), info(a, 'a'), info(sp, 'head-span')];
out.push('a 的上层规则命中：' + (a ? Array.from(document.styleSheets).flatMap((sh) => {
  try { return Array.from(sh.cssRules).filter((r) => r.selectorText && r.selectorText.includes('a') && a.matches(r.selectorText)).map((r) => r.selectorText + ' => ' + r.style.cssText.slice(0, 80)); } catch { return []; }
}).slice(0, 6).join(' | ') : '-'));
s.style.display = was;
return out.join('\n');
