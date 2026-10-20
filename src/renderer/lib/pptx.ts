// PPTX 渲染（OOXML）：除文本框与图片外，还原母版/版式背景、主题配色、
// 形状填充（纯色/渐变/图片）、边框、阴影、几何形状、项目符号与表格。
//
// 之前只画文本框和图片，所以"PPT 的背景啥的都看不到了"——背景其实来自
// slide → layout → master 三级继承的 p:bg，且颜色多为 a:schemeClr（需查主题配色），
// 缺任何一环都会变白底。这里按 PowerPoint 的规则做三级回退与主题色解析。
import JSZip from 'jszip';

const PX_PER_EMU = 96 / 914400;

// 主题占位色索引（p:bgRef / 形状 bgRef 的 idx 属性）
const IDX_MAP: Record<string, string> = {
  '1001': 'lt1', '1002': 'dk1', '1003': 'lt2', '1004': 'dk2',
  '1005': 'accent1', '1006': 'accent2', '1007': 'accent3',
  '1008': 'accent4', '1009': 'accent5', '1010': 'accent6',
  '1011': 'hlink', '1012': 'folHlink'
};

const PRST_CLR: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080',
  dkGray: '#404040', ltGray: '#c0c0c0', dkRed: '#800000', dkGreen: '#008000',
  dkBlue: '#000080', dkYellow: '#808000', dkCyan: '#008080', dkMagenta: '#800080',
  ltBlue: '#add8e6', ltGreen: '#90ee90', ltCyan: '#e0ffff', ltRed: '#ff8080',
  ltMagenta: '#ffb6c1', ltYellow: '#ffffe0', medGray: '#a0a0a0',
  darkRed: '#8b0000', darkGreen: '#006400', darkBlue: '#00008b', orange: '#ffa500',
  medBlue: '#0000cd', violet: '#800080', darkYellow: '#b8860b', lightBlue: '#add8e6',
  transparent: 'transparent'
};

type Theme = {
  colors: Record<string, string>;
  majorFont: string;
  minorFont: string;
};

// ---------- XML 辅助 ----------
type XmlNode = Element | Document | null;

/** 直接子元素；local 省略时返回全部元素子节点 */
function kids(node: XmlNode, local?: string): Element[] {
  if (!node) return [];
  const out: Element[] = [];
  const list = node.childNodes;
  for (let i = 0; i < list.length; i++) {
    const n = list[i] as Element;
    if (n.nodeType !== 1) continue;
    if (!local || localName(n) === local) out.push(n);
  }
  return out;
}

function desc(node: XmlNode, local: string): Element[] {
  if (!node) return [];
  return Array.from(node.getElementsByTagNameNS('*', local));
}

function first(node: XmlNode, local: string): Element | null {
  const a = desc(node, local);
  return a.length ? a[0] : null;
}

function firstKid(node: XmlNode, local: string): Element | null {
  const a = kids(node, local);
  return a.length ? a[0] : null;
}

function localName(n: Element): string {
  return n.localName || (n.nodeName || '').replace(/^.*:/, '');
}

function attr(n: XmlNode, name: string, alt?: string): string | null {
  if (!n || !(n as Element).getAttribute) return null;
  const v = (n as Element).getAttribute(name);
  if (v != null) return v;
  if (alt) return (n as Element).getAttribute(alt);
  return null;
}

function num(v: string | null, dflt = 0): number {
  const n = v == null ? NaN : parseFloat(v);
  return isNaN(n) ? dflt : n;
}

// ---------- 颜色 ----------
function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function rgbToCss(r: number, g: number, b: number, a?: number): string {
  if (a != null && a < 1) return `rgba(${clamp255(r)},${clamp255(g)},${clamp255(b)},${a.toFixed(3)})`;
  return `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`;
}

/**
 * 颜色字符串 → RGB。
 * 必须同时接受 #RRGGBB 与 rgb()/rgba()：主题色表里的值来自上一轮解析，
 * 已经是 rgb(...) 形式，只按十六进制解析会静默变成黑色（背景整片发黑的元凶）。
 */
function toRgb(v: string): [number, number, number] {
  const s = (v || '').trim();
  const h = s.charAt(0) === '#' ? s.slice(1) : s;
  // OOXML 的 srgbClr 直接写 6 位十六进制（无 # 前缀），这里一并兼容
  if (/^[0-9a-fA-F]{6}$/.test(h) || /^[0-9a-fA-F]{8}$/.test(h))
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  return [0, 0, 0];
}

/**
 * 解析颜色定义节点（a:srgbClr / a:schemeClr / a:prstClr / a:sysClr / a:hslClr / a:scrgbClr）。
 * 支持 lumMod / lumOff / shade / tint / alpha / alphaMod / alphaOff 修饰，按文档顺序应用。
 */
/**
 * @param phBase 当颜色写成 <a:schemeClr val="phClr"/> 时，phClr 指的是"被引用的那个色"
 *               （p:bgRef 的 idx 映射色 / 形状继承色）。不传的话只能落到兜底值，
 *               实测会让背景解析成黑色——这正是"背景不对"的常见原因。
 */
function colorOf(node: Element | null, theme: Theme, phBase?: string): string | null {
  if (!node) return null;
  const tag = localName(node);

  let rgb: [number, number, number] = [0, 0, 0];
  if (tag === 'srgbClr') rgb = toRgb(attr(node, 'val') || '000000');
  else if (tag === 'scrgbClr') {
    const to255 = (v: string | null) => Math.round(num(v, 0) / 100000 * 255);
    rgb = [to255(attr(node, 'r')), to255(attr(node, 'g')), to255(attr(node, 'b'))];
  } else if (tag === 'prstClr') rgb = toRgb(PRST_CLR[attr(node, 'val') || ''] || '000000');
  else if (tag === 'sysClr') rgb = toRgb(attr(node, 'lastClr') || '000000');
  else if (tag === 'hslClr') return hslToCss(num(attr(node, 'hue'), 0), num(attr(node, 'sat'), 0), num(attr(node, 'lum'), 0));
  else if (tag === 'schemeClr') {
    const key = attr(node, 'val') || '';
    if (key === 'phClr') rgb = toRgb(phBase || theme.colors.phClr || 'ffffff');
    else rgb = toRgb(theme.colors[key] || '000000');
  } else return null;

  let alpha: number | undefined;
  const al = firstKid(node, 'alpha');
  if (al) alpha = num(attr(al, 'val'), 100000) / 100000;

  // 修饰按出现顺序应用
  for (const ch of kids(node)) {
    const t = localName(ch);
    const v = num(attr(ch, 'val'), 0);
    if (t === 'shade' || t === 'lumMod') {
      const f = v / 100000;
      rgb = [rgb[0] * f, rgb[1] * f, rgb[2] * f];
    } else if (t === 'tint') {
      const f = v / 100000;
      rgb = [rgb[0] * f + 255 * (1 - f), rgb[1] * f + 255 * (1 - f), rgb[2] * f + 255 * (1 - f)];
    } else if (t === 'lumOff') {
      const f = v / 100000;
      rgb = [rgb[0] + 255 * f, rgb[1] + 255 * f, rgb[2] + 255 * f];
    } else if (t === 'alpha') {
      alpha = v / 100000;
    } else if (t === 'alphaMod') {
      alpha = (alpha == null ? 1 : alpha) * (v / 100000);
    } else if (t === 'alphaOff') {
      alpha = (alpha == null ? 1 : alpha) + v / 100000;
    }
  }

  if (alpha != null) alpha = Math.max(0, Math.min(1, alpha));
  return rgbToCss(rgb[0], rgb[1], rgb[2], alpha);
}

function hslToCss(hDeg: number, satPct: number, lumPct: number): string {
  const h = (hDeg / 60000) % 360;
  const s = (satPct / 100000) * 100;
  const l = (lumPct / 100000) * 100;
  return `hsl(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%)`;
}

function anyColor(parent: Element | null, theme: Theme, phBase?: string): string | null {
  if (!parent) return null;
  for (const t of ['srgbClr', 'schemeClr', 'prstClr', 'sysClr', 'hslClr', 'scrgbClr']) {
    const n = firstKid(parent, t);
    if (n) return colorOf(n, theme, phBase);
  }
  return null;
}

/**
 * 取「描边/边框」颜色。注意描边节点的颜色嵌在 a:solidFill 里面
 * （a:lnL > a:solidFill > a:schemeClr），直接用 anyColor 取不到，必须再下一层。
 */
function strokeColor(node: Element | null, theme: Theme): string | null {
  if (!node) return null;
  const s = first(node, 'solidFill');
  if (s) return anyColor(s, theme);
  const g = first(node, 'gradFill');
  if (g) {
    const gs = desc(g, 'gs')[0];
    if (gs) return anyColor(gs, theme);
  }
  const p = first(node, 'pattFill');
  if (p) {
    const fg = first(p, 'fgClr');
    if (fg) return anyColor(fg, theme);
  }
  return null;
}

// ---------- 关系 ----------
function resolveRel(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir + target).split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '..') stack.pop();
    else if (p && p !== '.') stack.push(p);
  }
  return stack.join('/');
}

async function relsOf(zip: JSZip, partPath: string): Promise<Record<string, string>> {
  const dir = partPath.replace(/[^/]+$/, '');
  const relPath = dir + '_rels/' + partPath.replace(/^.*\//, '') + '.rels';
  const f = zip.file(relPath);
  const map: Record<string, string> = {};
  if (!f) return map;
  try {
    const doc = new DOMParser().parseFromString(await f.async('text'), 'application/xml');
    for (const rel of desc(doc, 'Relationship')) {
      const id = attr(rel, 'Id') || '';
      const target = attr(rel, 'Target') || '';
      if (id) map[id] = resolveRel(dir, target);
    }
  } catch { /* 关系文件损坏时按空处理 */ }
  return map;
}

// ---------- 主题 ----------
async function loadTheme(zip: JSZip): Promise<Theme> {
  const theme: Theme = {
    colors: {
      dk1: '#000000', lt1: '#ffffff', dk2: '#44546a', lt2: '#e7e6e6',
      accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5',
      accent4: '#ffc000', accent5: '#5b9bd5', accent6: '#70ad47',
      hlink: '#0563c1', folHlink: '#954f72', tx1: '#000000', bg1: '#ffffff',
      tx2: '#44546a', bg2: '#e7e6e6', phClr: '#000000'
    },
    majorFont: 'Calibri Light',
    minorFont: 'Calibri'
  };

  const f = zip.file('ppt/theme/theme1.xml');
  if (!f) return theme;
  try {
    const doc = new DOMParser().parseFromString(await f.async('text'), 'application/xml');
    const scheme = first(doc, 'clrScheme');
    if (scheme) {
      for (const c of kids(scheme)) {
        const name = localName(c);
        const col = anyColor(c, theme);
        if (col) {
          theme.colors[name] = col;
          if (name === 'dk1') { theme.colors.tx1 = theme.colors.tx1 || col; }
          if (name === 'lt1') { theme.colors.bg1 = theme.colors.bg1 || col; }
        }
      }
      // tx/bg 别名指向对应主色
      if (theme.colors.dk1) theme.colors.tx1 = theme.colors.dk1;
      if (theme.colors.lt1) theme.colors.bg1 = theme.colors.lt1;
      if (theme.colors.dk2) theme.colors.tx2 = theme.colors.dk2;
      if (theme.colors.lt2) theme.colors.bg2 = theme.colors.lt2;
    }
    const fs = first(doc, 'fontScheme');
    if (fs) {
      const major = first(fs, 'majorFont');
      const minor = first(fs, 'minorFont');
      const latinOf = (n: Element | null) => {
        if (!n) return null;
        const l = first(n, 'latin');
        return l ? attr(l, 'typeface') : null;
      };
      theme.majorFont = latinOf(major) || theme.majorFont;
      theme.minorFont = latinOf(minor) || theme.minorFont;
    }
  } catch { /* 主题解析失败用默认值 */ }
  return theme;
}

// ---------- 几何 / 填充 ----------
function applyGeometry(sp: Element, div: HTMLElement): void {
  const geom = first(sp, 'prstGeom');
  if (!geom) return;
  const prst = attr(geom, 'prst') || 'rect';

  if (prst === 'ellipse') { div.style.borderRadius = '50%'; return; }
  if (prst === 'roundRect' || prst === 'round1Rect' || prst === 'round2SameRect' || prst === 'round2DiagRect') {
    const adjNode = first(geom, 'avLst') ? first(first(geom, 'avLst')!, 'gd') : null;
    const adj = adjNode ? num(attr(adjNode, 'fmla')?.replace(/^val\s*/, '') || attr(adjNode, 'fmla'), 16667) : 16667;
    const pct = Math.max(2, Math.min(50, (adj / 100000) * 100));
    div.style.borderRadius = pct.toFixed(1) + '%';
    return;
  }
  if (prst === 'pill') { div.style.borderRadius = '999px'; return; }
  if (prst === 'triangle') { div.style.clipPath = 'polygon(50% 0%,100% 100%,0% 100%)'; return; }
  if (prst === 'rtTriangle') { div.style.clipPath = 'polygon(0% 0%,100% 100%,0% 100%)'; return; }
  if (prst === 'diamond') { div.style.clipPath = 'polygon(50% 0%,100% 50%,50% 100%,0% 50%)'; return; }
  if (prst === 'parallelogram') { div.style.transform += ' skewX(-20deg)'; return; }
  if (prst === 'hexagon') {
    div.style.clipPath = 'polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)';
    return;
  }
  if (prst === 'pentagon') {
    div.style.clipPath = 'polygon(50% 0%,100% 38%,82% 100%,18% 100%,0% 38%)';
    return;
  }
  if (prst === 'chevron') {
    div.style.clipPath = 'polygon(0% 0%,75% 0%,100% 50%,75% 100%,0% 100%,25% 50%)';
    return;
  }
  if (prst === 'trapezoid') {
    div.style.clipPath = 'polygon(20% 0%,80% 0%,100% 100%,0% 100%)';
    return;
  }
  if (prst === 'line' || prst === 'straightConnector1') { div.style.height = '2px'; return; }
}

function cssAngleFromOoxml(ang: number): number {
  // OOXML：0=左→右，顺时针；CSS：0=下→上，逆时针
  return (90 + ang / 60000) % 360;
}

// ---------- 媒体（图片）资源 ----------
// 用 blob: URL 而不是 data:base64：base64 要多占 33% 内存、字符串拼接也慢，
// 一份 180 张图的胶片能差出上百 MB 和好几秒。
const mediaCache = new Map<string, string>();
let mediaUrls: string[] = [];

async function mediaUrl(zip: JSZip, path: string): Promise<string | null> {
  const hit = mediaCache.get(path);
  if (hit) return hit;
  const f = zip.file(path);
  if (!f) return null;
  try {
    const buf = await f.async('arraybuffer');
    const url = URL.createObjectURL(new Blob([buf], { type: mimeOfMedia(path) }));
    mediaCache.set(path, url);
    mediaUrls.push(url);
    return url;
  } catch {
    return null;
  }
}

/**
 * 开始渲染新文档：清掉上一份的媒体缓存。
 * 延迟回收：旧预览的懒渲染可能还有几帧在跑，立刻 revoke 会让画面裂图。
 */
function beginDocument(): void {
  const old = mediaUrls;
  mediaUrls = [];
  mediaCache.clear();
  if (old.length) {
    window.setTimeout(() => {
      for (const u of old) { try { URL.revokeObjectURL(u); } catch { } }
    }, 3000);
  }
}

async function applyBlipFill(
  zip: JSZip, fill: Element, rels: Record<string, string>, div: HTMLElement
): Promise<void> {
  const blip = first(fill, 'blip');
  if (!blip) return;
  const embed = attr(blip, 'r:embed', 'embed') || attr(blip, 'r:link', 'link');
  if (!embed || !rels[embed]) return;

  const url = await mediaUrl(zip, rels[embed]);
  if (!url) return;

  // a:srcRect 裁剪（单位为 1/100000）
  const srcRect = first(fill, 'srcRect');
  let l = 0, t = 0, r = 0, b = 0;
  if (srcRect) {
    l = num(attr(srcRect, 'l'), 0) / 100000;
    t = num(attr(srcRect, 't'), 0) / 100000;
    r = num(attr(srcRect, 'r'), 0) / 100000;
    b = num(attr(srcRect, 'b'), 0) / 100000;
  }
  const cw = Math.max(0.0001, 1 - l - r);
  const chh = Math.max(0.0001, 1 - t - b);

  div.style.backgroundImage = `url(${url})`;
  if (l || t || r || b) {
    div.style.backgroundSize = `${(100 / cw).toFixed(2)}% ${(100 / chh).toFixed(2)}%`;
    div.style.backgroundPosition = `${(-l * 100 / cw).toFixed(2)}% ${(-t * 100 / chh).toFixed(2)}%`;
  } else {
    const tile = first(fill, 'tile');
    if (tile) {
      const sx = num(attr(tile, 'sx'), 100000) / 100000;
      const sy = num(attr(tile, 'sy'), 100000) / 100000;
      div.style.backgroundRepeat = 'repeat';
      div.style.backgroundSize = `${(sx * 100).toFixed(2)}% ${(sy * 100).toFixed(2)}%`;
    } else {
      div.style.backgroundSize = '100% 100%';
    }
  }
  div.style.backgroundRepeat = div.style.backgroundRepeat || 'no-repeat';
}

async function applyFill(
  zip: JSZip, spPr: Element | null, rels: Record<string, string>, theme: Theme, div: HTMLElement
): Promise<void> {
  if (!spPr) return;

  const solid = firstKid(spPr, 'solidFill');
  if (solid) {
    const c = anyColor(solid, theme);
    if (c) div.style.background = c;
    return;
  }

  const grad = firstKid(spPr, 'gradFill');
  if (grad) {
    const gsLst = firstKid(grad, 'gsLst');
    const stops: string[] = [];
    if (gsLst) {
      for (const gs of kids(gsLst, 'gs')) {
        const pos = (num(attr(gs, 'pos'), 0) / 100000 * 100).toFixed(1);
        const c = anyColor(gs, theme);
        if (c) stops.push(`${c} ${pos}%`);
      }
    }
    const lin = firstKid(grad, 'lin');
    let ang = 0;
    if (lin) ang = num(attr(lin, 'ang'), 0);
    const path = firstKid(grad, 'path');
    if (path && attr(path, 'path') === 'circle') {
      div.style.background = stops.length >= 2
        ? `radial-gradient(circle, ${stops.join(',')})`
        : (stops[0] ? stops[0].split(' ')[0] : '');
    } else {
      div.style.background = stops.length >= 2
        ? `linear-gradient(${cssAngleFromOoxml(ang).toFixed(1)}deg, ${stops.join(',')})`
        : (stops[0] ? stops[0].split(' ')[0] : '');
    }
    return;
  }

  const blipFill = firstKid(spPr, 'blipFill');
  if (blipFill) {
    await applyBlipFill(zip, blipFill, rels, div);
    const duotone = first(blipFill, 'duotone');
    if (duotone) {
      // 近似：叠一层半透明色
      const c = anyColor(desc(duotone, 'schemeClr')[0] || desc(duotone, 'srgbClr')[0], theme);
      if (c) div.style.boxShadow = `inset 0 0 0 9999px ${c}`;
    }
    return;
  }

  if (firstKid(spPr, 'noFill')) div.style.background = 'transparent';
}

function applyLine(spPr: Element | null, theme: Theme, div: HTMLElement, scale: number): void {
  if (!spPr) return;
  const ln = firstKid(spPr, 'ln');
  if (!ln) return;

  const w = num(attr(ln, 'w'), 0) * PX_PER_EMU * scale;
  if (firstKid(ln, 'noFill') || w <= 0) { div.style.border = 'none'; return; }

  const c = strokeColor(ln, theme) || '#000000';
  const style: string = (() => {
    const dash = first(ln, 'prstDash');
    if (!dash) return 'solid';
    const v = attr(dash, 'val') || '';
    if (v === 'dash' || v === 'sysDash' || v === 'lgDash') return 'dashed';
    if (v === 'dot' || v === 'sysDot') return 'dotted';
    return 'solid';
  })();
  div.style.border = `${Math.max(1, w).toFixed(2)}px ${style} ${c}`;
}

function applyShadow(spPr: Element | null, theme: Theme, div: HTMLElement, scale: number): void {
  if (!spPr) return;
  const effect = firstKid(spPr, 'effectLst');
  if (!effect) return;
  const shdw = firstKid(effect, 'outerShdw');
  if (!shdw) return;
  const c = anyColor(shdw, theme) || 'rgba(0,0,0,.35)';
  const dist = num(attr(shdw, 'dist'), 0) * PX_PER_EMU * scale;
  const dir = num(attr(shdw, 'dir'), 0) * Math.PI / 180 / 60000;
  const blur = num(attr(shdw, 'blurRad'), 0) * PX_PER_EMU * scale;
  const dx = Math.cos(dir) * dist;
  const dy = Math.sin(dir) * dist;
  div.style.boxShadow = `${dx.toFixed(1)}px ${dy.toFixed(1)}px ${Math.max(0, blur).toFixed(1)}px ${c}`;
}

// ---------- 文本 ----------
function alignOf(a: string | null): string {
  if (a === 'ctr') return 'center';
  if (a === 'r') return 'right';
  if (a === 'just') return 'justify';
  return 'left';
}

function cssFontFamily(tf: string | null, theme: Theme): string | null {
  if (!tf) return null;
  if (tf === 'majorFont' || tf === '+mj-lt') return theme.majorFont;
  if (tf === 'minorFont' || tf === '+mn-lt') return theme.minorFont;
  return tf;
}

async function renderTextBody(
  zip: JSZip, txBody: Element | null, rels: Record<string, string>, theme: Theme,
  div: HTMLElement, scale: number, themeTextColor: string | null
): Promise<void> {
  if (!txBody) return;

  const bodyPr = firstKid(txBody, 'bodyPr');
  div.style.display = 'flex';
  div.style.flexDirection = 'column';
  const anchor = attr(bodyPr, 'anchor');
  div.style.justifyContent = anchor === 'b' ? 'flex-end' : (anchor === 'ctr' ? 'center' : 'flex-start');

  if (bodyPr) {
    const ins = (n: string) => num(attr(bodyPr, n), 91440) * PX_PER_EMU * scale;
    div.style.padding = `${ins('tIns').toFixed(1)}px ${ins('rIns').toFixed(1)}px ${ins('bIns').toFixed(1)}px ${ins('lIns').toFixed(1)}px`;
    const vert = attr(bodyPr, 'vert');
    if (vert === 'vert270' || vert === 'vert' || vert === 'eaVert') {
      div.style.writingMode = 'vertical-rl';
      div.style.justifyContent = '';
    }
  }

  // 默认段落样式（a:lstStyle/a:lvlNpPr/a:defRPr）
  const defaultColor = themeTextColor || theme.colors.tx1 || '#000000';

  const paras = kids(txBody, 'p');
  for (const p of paras) {
    const pPr = firstKid(p, 'pPr');
    const lvl = num(attr(pPr, 'lvl'), 0);

    const para = document.createElement('div');
    para.style.margin = '0';
    para.style.textAlign = alignOf(attr(pPr, 'algn'));

    // 缩进 / 行距 / 段间距
    if (pPr) {
      const marL = num(attr(pPr, 'marL'), 0) * PX_PER_EMU * scale;
      const ind = num(attr(pPr, 'indent'), 0) * PX_PER_EMU * scale;
      const total = marL + ind;
      if (total > 0.5) para.style.paddingLeft = total.toFixed(1) + 'px';
      const spcBef = firstKid(pPr, 'spcBef');
      if (spcBef) {
        const pts = firstKid(spcBef, 'spcPts');
        if (pts) para.style.marginTop = (num(attr(pts, 'val'), 0) * 96 / 72 * scale).toFixed(1) + 'px';
      }
      const spcAft = firstKid(pPr, 'spcAft');
      if (spcAft) {
        const pts = firstKid(spcAft, 'spcPts');
        if (pts) para.style.marginBottom = (num(attr(pts, 'val'), 0) * 96 / 72 * scale).toFixed(1) + 'px';
      }
      const lnSpc = firstKid(pPr, 'lnSpc');
      if (lnSpc) {
        const pts = firstKid(lnSpc, 'spcPts');
        if (pts) {
          const px = num(attr(pts, 'val'), 0) * 96 / 72 * scale;
          para.style.lineHeight = px.toFixed(1) + 'px';
        }
      }
    }

    // 项目符号
    let bulletHtml = '';
    if (pPr) {
      const buChar = firstKid(pPr, 'buChar');
      const buAuto = firstKid(pPr, 'buAutoNum');
      const buNone = firstKid(pPr, 'buNone');
      if (buChar) {
        const ch = attr(buChar, 'char') || '•';
        const szNode = firstKid(pPr, 'buSzPts') || firstKid(pPr, 'buSzPct');
        let szPx = 0;
        if (szNode) {
          szPx = localName(szNode) === 'buSzPts'
            ? num(attr(szNode, 'val'), 0) * 96 / 72 * scale
            : num(attr(szNode, 'val'), 100000) / 1000 * 12 * scale;
        }
        const buClrNode = firstKid(pPr, 'buClr');
        const buClr = anyColor(buClrNode, theme) || defaultColor;
        bulletHtml = `<span style="color:${buClr};${szPx ? `font-size:${szPx.toFixed(1)}px;` : ''}">${escapeHtml(ch)}</span>&nbsp;`;
      } else if (buAuto) {
        const type = attr(buAuto, 'type') || 'arabicPeriod';
        const start = num(attr(buAuto, 'startAt'), 1);
        const idx = kids(txBody, 'p').indexOf(p) + start;
        const mark = autoNumberMark(type, idx);
        bulletHtml = `<span style="color:${defaultColor}">${escapeHtml(mark)}</span>&nbsp;`;
      } else if (buNone) {
        bulletHtml = '';
      }
    }

    let html = '';
    let hasContent = false;

    for (const node of kids(p)) {
      const t = localName(node);
      if (t === 'pPr') continue;
      if (t === 'br') { html += '<br>'; hasContent = true; continue; }

      const rPr = firstKid(node, 'rPr') || firstKid(node, 'defRPr');
      let css = '';
      let text = '';

      if (t === 'r' || t === 'fld') {
        for (const tt of desc(node, 't')) text += tt.textContent || '';
      } else continue;

      if (rPr) {
        const sz = num(attr(rPr, 'sz'), 0);
        if (sz) css += `font-size:${(sz / 100 * 96 / 72 * scale).toFixed(2)}px;`;
        if (attr(rPr, 'b') === '1') css += 'font-weight:700;';
        if (attr(rPr, 'i') === '1') css += 'font-style:italic;';
        const u = attr(rPr, 'u');
        if (u && u !== 'none') css += 'text-decoration:underline;';
        if (attr(rPr, 'strike') === 'sngStrike' || attr(rPr, 'strike') === 'dblStrike') {
          css += 'text-decoration:line-through;';
        }
        if (attr(rPr, 'cap') === 'all') css += 'text-transform:uppercase;';

        const latin = first(rPr, 'latin');
        const fam = cssFontFamily(attr(latin, 'typeface') || attr(rPr, 'typeface'), theme);
        if (fam) css += `font-family:'${fam}',"Microsoft YaHei",sans-serif;`;

        const c = anyColor(rPr, theme);
        if (c) css += `color:${c};`;
        else css += `color:${defaultColor};`;

        const hl = firstKid(rPr, 'highlight');
        if (hl) {
          const hc = anyColor(hl, theme);
          if (hc) css += `background:${hc};`;
        }
        const spc = num(attr(rPr, 'spc'), 0);
        if (spc) css += `letter-spacing:${(spc / 100 * 96 / 72 * scale).toFixed(2)}px;`;
        const baseline = num(attr(rPr, 'baseline'), 0);
        if (baseline) css += `vertical-align:${(baseline / 1000 * 100).toFixed(0)}%;`;
      } else {
        css += `color:${defaultColor};`;
      }

      if (text) hasContent = true;
      html += `<span style="${css}">${escapeHtml(text).replace(/\n/g, '<br>')}</span>`;
    }

    if (hasContent || bulletHtml) para.innerHTML = bulletHtml + html;
    if (para.innerHTML) div.appendChild(para);
  }

  // 自动缩放（a:normAutofit fontScale）
  const norm = bodyPr ? first(bodyPr, 'normAutofit') : null;
  if (norm) {
    const fs = num(attr(norm, 'fontScale'), 0);
    if (fs) {
      const f = fs / 100000;
      div.querySelectorAll('span').forEach((s) => {
        const el = s as HTMLElement;
        const cur = el.style.fontSize;
        if (cur) el.style.fontSize = (parseFloat(cur) * f).toFixed(2) + 'px';
      });
    }
  }
}

function autoNumberMark(type: string, idx: number): string {
  switch (type) {
    case 'alphaLcPeriod': return String.fromCharCode(96 + idx) + '.';
    case 'alphaUcPeriod': return String.fromCharCode(64 + idx) + '.';
    case 'arabicParenRight': return idx + ')';
    case 'arabicPeriod': return idx + '.';
    case 'romanLcPeriod': return toRoman(idx).toLowerCase() + '.';
    case 'romanUcPeriod': return toRoman(idx) + '.';
    default: return idx + '.';
  }
}

function toRoman(n: number): string {
  const map: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mimeOfMedia(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', emf: 'image/x-emf',
    wmf: 'image/x-wmf', tif: 'image/tiff', tiff: 'image/tiff'
  };
  return map[ext] || 'image/png';
}

// ---------- 表格 ----------
async function renderTable(
  zip: JSZip, tbl: Element, rels: Record<string, string>, theme: Theme,
  container: HTMLElement, scale: number
): Promise<void> {
  const table = document.createElement('table');
  table.style.borderCollapse = 'collapse';
  table.style.width = '100%';
  table.style.height = '100%';

  const tblPr = first(tbl, 'tblPr');
  const firstRow = attr(tblPr, 'firstRow') === '1';
  const bandRow = attr(tblPr, 'bandRow') === '1';

  for (const tr of desc(tbl, 'tr')) {
    const row = document.createElement('tr');
    const h = num(attr(tr, 'h'), 0) * PX_PER_EMU * scale;
    if (h > 1) row.style.height = h.toFixed(1) + 'px';

    const cells = kids(tr, 'tc');
    let colIdx = 0;
    for (const tc of cells) {
      const td = document.createElement('td');
      const gridSpan = num(attr(tc, 'gridSpan'), 1);
      if (gridSpan > 1) td.colSpan = gridSpan;
      const rowSpan = attr(tc, 'rowSpan');
      if (rowSpan && num(rowSpan) > 1) td.rowSpan = num(rowSpan);
      if (attr(tc, 'vMerge') === 'cont') td.style.display = 'none';
      if (attr(tc, 'hMerge') === 'cont') td.style.display = 'none';

      const tcPr = first(tc, 'tcPr');
      if (tcPr) {
        const anchor = attr(tcPr, 'anchor');
        td.style.verticalAlign = anchor === 'ctr' ? 'middle' : (anchor === 'b' ? 'bottom' : 'top');
        const marL = num(attr(tcPr, 'marL'), 91440) * PX_PER_EMU * scale;
        const marR = num(attr(tcPr, 'marR'), 91440) * PX_PER_EMU * scale;
        const marT = num(attr(tcPr, 'marT'), 45720) * PX_PER_EMU * scale;
        const marB = num(attr(tcPr, 'marB'), 45720) * PX_PER_EMU * scale;
        td.style.padding = `${marT.toFixed(1)}px ${marR.toFixed(1)}px ${marB.toFixed(1)}px ${marL.toFixed(1)}px`;
        await applyFill(zip, tcPr, rels, theme, td as HTMLElement);

        // 单元格边框
        const borders: string[] = ['lnL', 'lnR', 'lnT', 'lnB'];
        const sides: string[] = ['left', 'right', 'top', 'bottom'];
        borders.forEach((b, i) => {
          const n = firstKid(tcPr, b);
          if (!n) return;
          if (firstKid(n, 'noFill')) { (td.style as any)[`border${cap(sides[i])}`] = 'none'; return; }
          const w = num(attr(n, 'w'), 0) * PX_PER_EMU * scale;
          const c = strokeColor(n, theme) || '#999999';
          (td.style as any)[`border${cap(sides[i])}`] = `${Math.max(1, w).toFixed(1)}px solid ${c}`;
        });
      } else {
        td.style.border = '1px solid #999';
        td.style.verticalAlign = 'middle';
      }

      // 表头行/隔行配色（tblPr 生效时给个近似底色）
      if (firstRow && desc(tbl, 'tr').indexOf(tr) === 0 && !td.style.background) {
        td.style.background = theme.colors.accent1 || '#4472c4';
      } else if (bandRow && desc(tbl, 'tr').indexOf(tr) % 2 === 1 && !td.style.background) {
        td.style.background = theme.colors.lt2 || '#f2f2f2';
      }

      const txBody = first(tc, 'txBody');
      const inner = document.createElement('div');
      inner.style.width = '100%';
      inner.style.height = '100%';
      await renderTextBody(zip, txBody, rels, theme, inner, scale,
        firstRow && desc(tbl, 'tr').indexOf(tr) === 0 ? '#ffffff' : (theme.colors.tx1 || '#000000'));
      // 单元格内文字默认居中偏上
      const pPr = txBody ? first(txBody, 'pPr') : null;
      if (!pPr) inner.style.textAlign = 'center';
      td.appendChild(inner);
      row.appendChild(td);
      colIdx++;
    }
    table.appendChild(row);
  }
  container.appendChild(table);
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- 形状 ----------
interface Layer {
  doc: Document;
  rels: Record<string, string>;
  isMaster: boolean;
}

const SKIP_PH = new Set(['dt', 'ftr', 'sldNum']);

async function renderShapeTree(
  zip: JSZip, layer: Layer, spTree: Element | null, theme: Theme,
  container: HTMLElement, scale: number, overridden: Set<string>, collectPh: boolean
): Promise<void> {
  if (!spTree) return;

  for (const node of kids(spTree)) {
    const tag = localName(node);
    if (tag === 'nvGrpSpPr' || tag === 'grpSpPr') continue;

    if (tag === 'grpSp') {
      // 组合：按组变换整体缩放，内部坐标相对组原点
      const inner = document.createElement('div');
      const xfrm = first(node, 'xfrm');
      let gx = 0, gy = 0, sc = 1;
      if (xfrm) {
        const off = first(xfrm, 'off'); const ext = first(xfrm, 'ext');
        const chOff = first(xfrm, 'chOff'); const chExt = first(xfrm, 'chExt');
        gx = num(attr(off, 'x')) * PX_PER_EMU * scale;
        gy = num(attr(off, 'y')) * PX_PER_EMU * scale;
        if (chExt && ext) {
          const cw = num(attr(chExt, 'cx'));
          const w = num(attr(ext, 'cx'));
          if (cw) sc = w / cw;
        }
        // 组内子形状坐标是相对 chOff 的，容器要先平移掉 chOff，子形状才能落到正确位置
        if (chOff) {
          gx -= num(attr(chOff, 'x')) * PX_PER_EMU * scale * sc;
          gy -= num(attr(chOff, 'y')) * PX_PER_EMU * scale * sc;
        }
      }
      inner.style.position = 'absolute';
      inner.style.left = gx.toFixed(1) + 'px';
      inner.style.top = gy.toFixed(1) + 'px';
      container.appendChild(inner);
      await renderShapeTree(zip, layer, node, theme, inner, scale * sc, overridden, collectPh);
      continue;
    }

    if (tag !== 'sp' && tag !== 'pic' && tag !== 'graphicFrame' && tag !== 'cxnSp') continue;

    // 占位符处理：母版/版式里的占位符若已被幻灯片覆盖则跳过
    const nvSpPr = first(node, 'nvSpPr') || first(node, 'nvPicPr') || first(node, 'nvGraphicFramePr');
    const ph = nvSpPr ? first(nvSpPr, 'ph') : null;
    const phType = ph ? (attr(ph, 'type') || 'body') : null;
    const phIdx = ph ? (attr(ph, 'idx') || '') : '';

    // 母版 / 版式里的占位符一律不绘制。
    // PowerPoint 中这些形状的文本是编辑态提示语（"Click to edit Master title style"
    // "Click to edit Master text styles / Second level / Third level…"），放映和预览时
    // 都【不显示】；之前把它们当普通形状画出来，会在真实内容上盖一整段提示文字，
    // 表现为「预览内容和实际 PPT 完全不一样」。
    // 占位符的几何/字号仍会通过 slide 自身形状的继承生效，缺失不影响版式。
    // 母版里真正需要绘制的只有非占位符形状（装饰图形、logo 等），照常渲染。
    if (ph && !collectPh) continue;

    // 空占位符（无文本、无填充、无线条）不画，避免一堆空框
    const txBody = first(node, 'txBody');
    const hasText = txBody ? desc(txBody, 't').some((t) => (t.textContent || '').trim()) : false;
    const spPr = first(node, 'spPr') || first(node, 'picPr');
    const hasFill = spPr ? (firstKid(spPr, 'solidFill') || firstKid(spPr, 'gradFill')
      || firstKid(spPr, 'blipFill') || firstKid(spPr, 'pattFill')) : false;
    if (ph && !hasText && !hasFill) continue;

    const xfrm = first(node, 'xfrm');
    let x = 0, y = 0, w = 0, h = 0, rot = 0, flipH = false, flipV = false;
    if (xfrm) {
      const off = first(xfrm, 'off'); const ext = first(xfrm, 'ext');
      x = num(attr(off, 'x')) * PX_PER_EMU * scale;
      y = num(attr(off, 'y')) * PX_PER_EMU * scale;
      w = num(attr(ext, 'cx')) * PX_PER_EMU * scale;
      h = num(attr(ext, 'cy')) * PX_PER_EMU * scale;
      rot = num(attr(xfrm, 'rot')) / 60000;
      flipH = attr(xfrm, 'flipH') === '1';
      flipV = attr(xfrm, 'flipV') === '1';
    }

    const div = document.createElement('div');
    div.className = 'shape';
    div.style.left = x.toFixed(1) + 'px';
    div.style.top = y.toFixed(1) + 'px';
    div.style.width = Math.max(0, w).toFixed(1) + 'px';
    div.style.height = Math.max(0, h).toFixed(1) + 'px';

    const tf: string[] = [];
    if (rot) tf.push(`rotate(${(rot / 100).toFixed(2)}deg)`);
    if (flipH) tf.push('scaleX(-1)');
    if (flipV) tf.push('scaleY(-1)');
    if (tf.length) div.style.transform = tf.join(' ');

    if (tag === 'pic') {
      const blipFill = first(node, 'blipFill');
      if (blipFill) await applyBlipFill(zip, blipFill, layer.rels, div);
      // 注意：不要给形状设 title=形状名。那是调试信息，浏览器会把 title 渲染成
      // 悬停 tooltip（"Rounded Rectangle 11"），用户截图里会误以为是预览出错。
      applyLine(spPr, theme, div, scale);
      applyShadow(spPr, theme, div, scale);
      container.appendChild(div);
      continue;
    }

    if (tag === 'graphicFrame') {
      applyGeometry(node, div);
      await applyFill(zip, spPr, layer.rels, theme, div);
      const tbl = first(node, 'tbl');
      if (tbl) {
        await renderTable(zip, tbl, layer.rels, theme, div, scale);
      } else {
        // 图表 / SmartArt / OLE：没有可行的纯前端渲染，给个占位说明
        const ph2 = document.createElement('div');
        ph2.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:13px;';
        ph2.textContent = '（图表 / 图示对象，预览中不予渲染）';
        div.appendChild(ph2);
      }
      applyLine(spPr, theme, div, scale);
      container.appendChild(div);
      continue;
    }

    // sp / cxnSp
    await applyFill(zip, spPr, layer.rels, theme, div);
    applyGeometry(node, div);
    applyLine(spPr, theme, div, scale);
    applyShadow(spPr, theme, div, scale);

    if (txBody) {
      const inner = document.createElement('div');
      inner.style.position = 'absolute';
      inner.style.left = '0';
      inner.style.top = '0';
      inner.style.width = '100%';
      inner.style.height = '100%';
      inner.style.overflow = 'hidden';
      inner.style.boxSizing = 'border-box';
      // 文本框默认文字色：优先形状自身的，其次主题 tx1
      await renderTextBody(zip, txBody, layer.rels, theme, inner, scale, theme.colors.tx1 || '#000000');
      div.appendChild(inner);
    }

    // 同理不设 title（形状名会变成悬停 tooltip）
    container.appendChild(div);
  }
}

// ---------- 背景 ----------
async function applyBackground(
  zip: JSZip, bgNode: Element | null, rels: Record<string, string>, theme: Theme, slide: HTMLElement
): Promise<void> {
  if (!bgNode) { slide.style.background = '#ffffff'; return; }

  const refIdx = attr(bgNode, 'bgRef');       // p:bg 上的 bgRef 属性在 a: 命名空间外
  const refIdxAttr = attr(bgNode, 'p:bgRef') || refIdx;
  const bgPr = firstKid(bgNode, 'bgPr') || first(bgNode, 'bgPr');
  const bgRef = firstKid(bgNode, 'bgRef') || first(bgNode, 'bgRef');

  if (bgPr) {
    // 背景色/渐变/图片都嵌在 bgPr 里，applyFill 负责解析。
    //
    // 【坑】千万别在这里写 slide.style.background = '#ffffff' 兜底：
    // background 是简写属性，赋值会把 background-image 一并重置成 none，
    // 结果"版式里配了背景图片"的胶片（厂商主打胶片都是这种）全变白底。
    await applyFill(zip, bgPr, rels, theme, slide);
    if (!slide.style.backgroundImage && !slide.style.backgroundColor && !slide.style.background) {
      slide.style.backgroundColor = '#ffffff';
    }
    return;
  }

  if (bgRef || refIdxAttr) {
    // 常见写法：<p:bgRef idx="1001"><a:schemeClr val="phClr"/></p:bgRef>
    // phClr 指的就是 idx 映射到的主题色，必须把该色作为 phBase 传进去，
    // 否则会被解析成默认黑，幻灯片整片黑底。
    const idx = attr(bgRef, 'idx') || refIdxAttr || '';
    const key = IDX_MAP[idx] || 'lt1';
    const base = theme.colors[key] || theme.colors.lt1 || '#ffffff';
    const mod = bgRef ? anyColor(bgRef, theme, base) : null;
    slide.style.background = mod || base;
    return;
  }

  slide.style.background = '#ffffff';
}

// ---------- 入口 ----------
export interface PptxOptions {
  /** 懒渲染的滚动观察根（一般传预览区 body）；不传则用视口 */
  root?: HTMLElement | null;
  /** 返回 true 表示这次预览已被别的文件取代，应立即停止后续渲染 */
  stale?: () => boolean;
}

async function parsePart(zip: JSZip, path: string | null): Promise<Document | null> {
  if (!path) return null;
  const f = zip.file(path);
  if (!f) return null;
  try {
    return new DOMParser().parseFromString(await f.async('text'), 'application/xml');
  } catch {
    return null;
  }
}

/** 从 rels 里找第一个路径匹配正则的部件（如 slideLayoutN.xml / slideMasterN.xml）。 */
function relMatching(rels: Record<string, string>, re: RegExp): string | null {
  for (const k of Object.keys(rels)) if (re.test(rels[k])) return rels[k];
  return null;
}

interface LayoutCtx {
  layoutDoc: Document | null;
  layoutRels: Record<string, string>;
  masterDoc: Document | null;
  masterRels: Record<string, string>;
}

/**
 * 渲染 pptx。
 *
 * 【性能】大胶片（几十页、上百张图）以前是"所有页同步渲染完才返回"，
 * 用户要盯着"解析文档…"等十几秒。现在改成：
 *   1) 先把每页的空白占位框按真实尺寸铺好（滚动条、页面位置立刻正确）；
 *   2) 只同步渲染第一页，函数随即返回；
 *   3) 其余页用 IntersectionObserver 在接近视口时才渲染（rootMargin 800px 预取）。
 * 配合媒体走 blob URL、版式/母版只解析一次，首屏从十几秒降到 1 秒内。
 */
export async function renderPptx(
  arrayBuffer: ArrayBuffer,
  targetWidth = 960,
  opts: PptxOptions = {}
): Promise<HTMLElement> {
  const stale = opts.stale || (() => false);

  beginDocument();

  const zip = await JSZip.loadAsync(arrayBuffer);
  const theme = await loadTheme(zip);

  const presRels = await relsOf(zip, 'ppt/presentation.xml');
  let cx = 9144000, cy = 6858000;
  const pres = zip.file('ppt/presentation.xml');
  let slidePaths: string[] = [];
  if (pres) {
    const pxml = await pres.async('text');
    const m = /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(pxml);
    if (m) { cx = +m[1]; cy = +m[2]; }

    // 按 sldIdLst 的真实放映顺序排列
    const doc = new DOMParser().parseFromString(pxml, 'application/xml');
    for (const id of desc(doc, 'sldId')) {
      const rid = attr(id, 'r:id') || attr(id, 'id');
      const p = rid && presRels[rid] ? presRels[rid] : null;
      if (p) slidePaths.push(p);
    }
  }
  if (!slidePaths.length) {
    slidePaths = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = +(/slide(\d+)\.xml$/.exec(a)![1]);
        const nb = +(/slide(\d+)\.xml$/.exec(b)![1]);
        return na - nb;
      });
  }

  const scale = targetWidth / (cx * PX_PER_EMU);
  const slideW = targetWidth;
  const slideH = cy * PX_PER_EMU * scale;

  const container = document.createElement('div');
  container.style.width = slideW + 'px';
  container.style.margin = '0 auto';

  // 占位框：先按真实尺寸铺满，滚动位置与页数立刻正确
  const slides: HTMLElement[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const el = document.createElement('div');
    el.className = 'slide';
    el.style.width = slideW + 'px';
    el.style.height = slideH.toFixed(1) + 'px';
    el.dataset.slideIndex = String(i);
    slides.push(el);
    container.appendChild(el);
  }
  if (!slides.length) return container;

  // 版式/母版解析结果缓存：同一份胶片几十页往往共用同几个版式，
  // 以前每页都重新解析一遍 XML，是另一个主要卡顿源。
  const layoutCache = new Map<string, Promise<LayoutCtx>>();
  function sharedLayout(path: string | null): Promise<LayoutCtx> {
    const key = path || '';
    let p = layoutCache.get(key);
    if (!p) {
      p = (async (): Promise<LayoutCtx> => {
        const layoutDoc = await parsePart(zip, path);
        const layoutRels = path ? await relsOf(zip, path) : {};
        const masterPath = layoutDoc ? relMatching(layoutRels, /slideMaster\d+\.xml$/) : null;
        const masterDoc = await parsePart(zip, masterPath);
        const masterRels = masterPath ? await relsOf(zip, masterPath) : {};
        return { layoutDoc, layoutRels, masterDoc, masterRels };
      })();
      layoutCache.set(key, p);
    }
    return p;
  }

  // 并发闸门：IntersectionObserver 一次可能同时唤起好几页（rootMargin 800px
  // 在快速滚动时能命中 3~5 页）。几十页同时解压同一份 zip 会抢占 CPU、内存翻倍，
  // 实测在低配环境会出现"部分页只留空白占位"的现象。这里限制同时渲染 2 页。
  let active = 0;
  const slotWaiters: Array<() => void> = [];
  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= 2) await new Promise<void>((r) => slotWaiters.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = slotWaiters.shift();
      if (next) next();
    }
  }

  async function renderSlide(i: number): Promise<void> {
    const el = slides[i];
    if (!el || el.dataset.rendered === '1') return;
    if (stale()) return;
    el.dataset.rendered = '1';

    try {
      await withSlot(() => renderSlideInner(i, el));
      // data-rendered 只表示"开始渲染过"（用于去重），data-done 才表示画完了。
      // 自动化校验/调试需要后者，否则会在渲染进行中就统计到 0 个形状。
      el.dataset.done = '1';
    } catch (e) {
      // 单页失败（个别模板的怪形状 / 坏关系）不能拖垮整份文档：
      // 清掉标记让调用方可重试，并留一条警告，避免"某些页永远空白"却查不到原因。
      delete el.dataset.rendered;
      if (typeof console !== 'undefined') {
        console.warn('PPT 第 ' + (i + 1) + ' 页渲染失败：' + ((e as Error)?.message || String(e)));
      }
    }
  }

  async function renderSlideInner(i: number, el: HTMLElement): Promise<void> {
    const sp = slidePaths[i];
    const slideDoc = await parsePart(zip, sp);
    if (!slideDoc) { delete el.dataset.rendered; return; }
    const slideRels = await relsOf(zip, sp);

    const layoutPath = relMatching(slideRels, /slideLayout\d+\.xml$/);
    const { layoutDoc, layoutRels, masterDoc, masterRels } = await sharedLayout(layoutPath);
    if (stale()) return;

    // 背景：slide → layout → master 三级回退（"看不到背景"的根因就在这里）
    const slideBg = first(slideDoc, 'bg');
    const layoutBg = layoutDoc ? first(layoutDoc, 'bg') : null;
    const masterBg = masterDoc ? first(masterDoc, 'bg') : null;
    const bgNode = slideBg || layoutBg || masterBg;
    const bgOwner = slideBg ? slideRels : (layoutBg ? layoutRels : masterRels);
    await applyBackground(zip, bgNode, bgOwner, theme, el);

    // 收集幻灯片里已填充的占位符，用于决定母版/版式里的同款占位符要不要画
    const overridden = new Set<string>();
    const slideSpTree = first(slideDoc, 'spTree');
    if (slideSpTree) {
      for (const n of kids(slideSpTree)) {
        const nv = first(n, 'nvSpPr') || first(n, 'nvPicPr') || first(n, 'nvGraphicFramePr');
        const ph = nv ? first(nv, 'ph') : null;
        if (!ph) continue;
        const type = attr(ph, 'type') || 'body';
        const idx = attr(ph, 'idx') || '';
        const txBody = first(n, 'txBody');
        const hasText = txBody ? desc(txBody, 't').some((t) => (t.textContent || '').trim()) : false;
        if (hasText) { overridden.add(type + '#' + idx); overridden.add(type); }
      }
    }

    if (masterDoc) {
      await renderShapeTree(zip, { doc: masterDoc, rels: masterRels, isMaster: true },
        first(masterDoc, 'spTree'), theme, el, scale, overridden, false);
    }
    if (stale()) return;
    if (layoutDoc) {
      await renderShapeTree(zip, { doc: layoutDoc, rels: layoutRels, isMaster: false },
        first(layoutDoc, 'spTree'), theme, el, scale, overridden, false);
    }
    if (stale()) return;
    await renderShapeTree(zip, { doc: slideDoc, rels: slideRels, isMaster: false },
      slideSpTree, theme, el, scale, overridden, true);
  }

  // 第一页同步渲染（用户打开就要看到它）
  await renderSlide(0);

  // 其余页按滚动懒渲染
  const rest: number[] = [];
  for (let i = 1; i < slides.length; i++) rest.push(i);

  const attachObserver = () => {
    if (stale() || !rest.length) return;

    if (typeof IntersectionObserver === 'undefined') {
      void (async () => {
        for (const i of rest) {
          if (stale()) return;
          await renderSlide(i);
          await new Promise((r) => window.setTimeout(r, 0));
        }
      })();
      return;
    }

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const idx = Number((e.target as HTMLElement).dataset.slideIndex);
        io.unobserve(e.target);
        void renderSlide(idx);
      }
    }, { root: (opts.root as Element) || null, rootMargin: '800px 0px' });

    for (const i of rest) io.observe(slides[i]);

    // 预览被切换时及时断开，避免继续为不可见的页做无用渲染
    const stop = () => { if (stale()) { io.disconnect(); return true; } return false; };
    const timer = window.setInterval(() => { if (stop()) window.clearInterval(timer); }, 800);
  };

  // 等容器被插入 DOM 后再观察（否则拿不到布局，交不出交叉结果）
  window.setTimeout(attachObserver, 0);

  return container;
}
