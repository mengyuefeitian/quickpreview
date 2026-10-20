// docx 页眉 / 页脚继承修正
//
// 【问题】Word 的页眉页脚规则是「节内没写引用就继承上一节」：
//   sectPr 里只有真正改过页眉的节才带 headerReference/footerReference，
//   后面几十个节往往一个引用都没有，全靠继承。
// docx-preview 不做继承（renderHeaderFooter 只在 refs 存在时渲染），
//   于是「第一节（封面）有页眉，后面所有页都没有」—— 实测 26 页的手册只有第 1 页有页眉页脚。
//
// 另外 titlePg（首页不同）在 docx-preview 里的回退是错的：
//   refs.find(first) ?? refs.find(default) —— 首页没有 first 引用时会退到 default，
//   于是封面被硬塞上正文的页眉页脚。Word 的语义是「首页用 first，没定义就是空白」。
//
// 这里在交给 docx-preview 之前把 document.xml 补成「每节都写全引用」：
//   1. 逐节按类型继承上一节的 header/footer 引用；
//   2. titlePg 的节若拿不到 first 引用，补一个指向空白页眉/页脚部件的 first 引用。
//
// 【为什么用字符串改写而不是 DOMParser】3MB 的手册实测：解析 + 序列化 320KB 的
// document.xml 要 200ms 上下，而只替换 sectPr 片段只要几毫秒；而且整篇 XML 过一遍
// XMLSerializer 还会顺带改动命名空间前缀、实体写法，风险比定点替换大得多。
// 代价是要自己认命名空间前缀 —— 从根元素的 xmlns 声明里取，取不到就放弃（返回 null）。
import JSZip from 'jszip';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const REL_HEADER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
const REL_FOOTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const CT_HEADER = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const CT_FOOTER = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

const BLANK_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
  + `<w:hdr xmlns:w="${NS_W}"><w:p/></w:hdr>`;
const BLANK_FOOTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
  + `<w:ftr xmlns:w="${NS_W}"><w:p/></w:ftr>`;

export interface SectionFixResult {
  /** 补出来的继承引用条数 */
  inherited: number;
  /** 为 titlePg 节补的空白首页页眉（+页脚）引用条数 */
  blankFirst: number;
  /** 节数 */
  sections: number;
  /** 分步耗时（毫秒），用来盯住预处理开销 */
  ms?: { load: number; xml: number; zip: number };
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// r:id 占位符：算完 rels 里的重名情况后统一替换成真实 id
const PH_HEADER = '__QP_BLANK_HEADER__';
const PH_FOOTER = '__QP_BLANK_FOOTER__';

function prefixOf(xml: string, ns: string): string | null {
  const m = new RegExp(`xmlns:([A-Za-z0-9_.-]+)="\\s*${esc(ns)}\\s*"`).exec(xml);
  return m ? m[1] : null;
}

function typeOf(ref: string, wp: string): string {
  const m = new RegExp(`${esc(wp)}:type="([^"]*)"`).exec(ref);
  return m ? m[1] : 'default';
}

// 把继承来的引用改成目标类型（没有 type 属性就在标签名后面补一个）
function retype(ref: string, wp: string, kind: string, type: string): string {
  const attr = new RegExp(`\\s${esc(wp)}:type="[^"]*"`);
  if (attr.test(ref)) return ref.replace(attr, ` ${wp}:type="${type}"`);
  return ref.replace(new RegExp(`^<${esc(wp)}:${kind}Reference\\b`), `<$& ${wp}:type="${type}"`);
}

/**
 * 返回修正后的 docx 数据；不需要修改（或不是 docx）时返回 null，调用方应当用原数据。
 */
export async function fixSectionHeaderFooter(
  ab: ArrayBuffer
): Promise<{ data: Blob; info: SectionFixResult } | null> {
  const tA = Date.now();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(ab);
  } catch {
    return null;
  }
  const docFile = zip.file('word/document.xml');
  if (!docFile) return null;

  const tB = Date.now();
  const xml = await docFile.async('string');

  const wp = prefixOf(xml, NS_W);
  const rp = prefixOf(xml, NS_R);
  if (!wp || !rp) return null;

  // 整篇都没有页眉页脚引用 → 不需要动它
  if (!new RegExp(`<${esc(wp)}:(header|footer)Reference\\b`).test(xml)) return null;

  const needBlank = { header: false, footer: false };
  // 继承状态：按 type（default/first/even）记住上一节用的是什么引用原文
  const cur: Record<'header' | 'footer', Record<string, string | null>> = {
    header: { default: null, first: null, even: null },
    footer: { default: null, first: null, even: null },
  };
  let inherited = 0;
  let blankFirst = 0;
  let sections = 0;

  const sectRe = new RegExp(
    `<${esc(wp)}:sectPr\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:/>|>([\\s\\S]*?)</${esc(wp)}:sectPr>)`, 'g');

  const out = xml.replace(sectRe, (whole: string, attrs: string, bodyRaw?: string) => {
    const body = bodyRaw || '';
    sections++;
    const add: string[] = [];

    for (const kind of ['header', 'footer'] as const) {
      const refRe = new RegExp(`<${esc(wp)}:${kind}Reference\\b[^>]*/>`, 'g');
      const own = body.match(refRe) || [];
      const have = new Set(own.map((r) => typeOf(r, wp)));

      // 1) 缺失的类型从上一节继承（引用原文直接搬，只改 type）
      for (const t of ['default', 'first', 'even']) {
        const prev = cur[kind][t];
        if (!prev || have.has(t)) continue;
        add.push(retype(prev, wp, kind, t));
      }
      // 2) 记录本节当前生效的引用（own 覆盖继承值）；add 里的也要记，供下一节继续继承
      for (const r of own) cur[kind][typeOf(r, wp)] = r;
      for (const r of add) cur[kind][typeOf(r, wp)] = r;
      inherited += add.length;

      // 3) titlePg 且拿不到 first 引用 → 补一个指向空白部件的 first 引用
      const titlePg = new RegExp(`<${esc(wp)}:titlePg\\b([^>]*?)/?>`).exec(body);
      const disabled = new RegExp(`\\s${esc(wp)}:val="(0|false|off)"`);
      if (titlePg && !disabled.test(titlePg[1]) && !own.some((r) => typeOf(r, wp) === 'first')
        && cur[kind].default) {
        // 关系 id 先写占位符，等算过 rels 里的重名情况再统一替换
        const ph = kind === 'header' ? PH_HEADER : PH_FOOTER;
        const el = `<${wp}:${kind}Reference ${wp}:type="first" ${rp}:id="${ph}"/>`;
        add.push(el);
        cur[kind].first = el;
        needBlank[kind] = true;
        blankFirst++;
      }
    }

    if (!add.length) return whole;
    // 引用必须排在 sectPr 最前面（OOXML 子元素顺序是 schema 校验的）
    return `<${wp}:sectPr${attrs}>${add.join('')}${body}</${wp}:sectPr>`;
  });

  if (!inherited && !blankFirst) return null;

  let docXml = out;

  if (needBlank.header || needBlank.footer) {
    if (needBlank.header) zip.file('word/headerQpBlank.xml', BLANK_HEADER);
    if (needBlank.footer) zip.file('word/footerQpBlank.xml', BLANK_FOOTER);

    const relFile = zip.file('word/_rels/document.xml.rels');
    if (relFile) {
      const rels = await relFile.async('string');
      const used = new Set(Array.from(rels.matchAll(/\bId="([^"]*)"/g), (m) => m[1]));
      const extra: string[] = [];
      const addRel = (base: string, ph: string, type: string, target: string): void => {
        let id = base;
        let n = 1;
        while (used.has(id)) id = `${base}_${n++}`;   // 撞了就换一个，占位符一并替换
        used.add(id);
        extra.push(`<Relationship Id="${id}" Type="${type}" Target="${target}"/>`);
        docXml = docXml.split(ph).join(id);
      };
      if (needBlank.header) addRel('rIdQpBlankHeader', PH_HEADER, REL_HEADER, 'headerQpBlank.xml');
      if (needBlank.footer) addRel('rIdQpBlankFooter', PH_FOOTER, REL_FOOTER, 'footerQpBlank.xml');
      zip.file('word/_rels/document.xml.rels',
        rels.replace(/<\/Relationships>\s*$/, `${extra.join('')}</Relationships>`));
    }

    const ctFile = zip.file('[Content_Types].xml');
    if (ctFile) {
      const ct = await ctFile.async('string');
      const extra: string[] = [];
      if (needBlank.header) {
        extra.push(`<Override PartName="/word/headerQpBlank.xml" ContentType="${CT_HEADER}"/>`);
      }
      if (needBlank.footer) {
        extra.push(`<Override PartName="/word/footerQpBlank.xml" ContentType="${CT_FOOTER}"/>`);
      }
      zip.file('[Content_Types].xml', ct.replace(/<\/Types>\s*$/, `${extra.join('')}</Types>`));
    }
  }

  zip.file('word/document.xml', docXml);

  const tC = Date.now();
  // level 1：这是内存里的临时包，压得越小越慢没必要；图片本身已是压缩格式，重压也不会更小
  const data = await zip.generateAsync({
    type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 }
  });
  const tD = Date.now();
  return {
    data,
    info: { inherited, blankFirst, sections, ms: { load: tB - tA, xml: tC - tB, zip: tD - tC } }
  };
}
