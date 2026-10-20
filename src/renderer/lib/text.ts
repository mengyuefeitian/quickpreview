// 大文本分块加载查看器
//
// 以前是一次性把整个文件读进内存 → TextDecoder 解码 → escapeHtml → 生成一个巨大的
// <pre> 文本节点。几百 MB 的电子书在这一步会同时吃掉巨量内存并触发超长 Layout，
// 表现就是"拖动/打开超大 txt 直接卡死"。
//
// 现在改成按 Range 分块流式读取：
//   · 首屏只取 256KB，立刻可读；
//   · 滚动到底部（或点"继续加载"）再取下一块，追加一个文本节点；
//   · TextDecoder 用 stream 模式，跨块的多字节字符不会被截断成乱码。
import { appLocalUrl, el } from './util';
import { postToHost } from './host';

const CHUNK_SIZE = 256 * 1024;          // 每块 256KB
const MAX_CHUNK_SIZE = 4 * 1024 * 1024; // 网络异常时退让的上限
const AUTO_MARGIN = '600px';            // 距底部 600px 时预取下一块

export interface TextViewerOptions {
  stale: () => boolean;
}

function humanSize(n: number): string {
  if (n < 0) return '未知';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 渲染文本文件（分块）。
 * @returns 已加载字节数
 */
export async function renderTextViewer(
  path: string, body: HTMLElement, bar: HTMLElement, opts: TextViewerOptions
): Promise<number> {
  body.innerHTML = '';

  const wrap = el('div', 'text-wrap');
  const pre = el('pre', 'text-content');
  const foot = el('div', 'text-more');
  wrap.appendChild(pre);
  wrap.appendChild(foot);
  body.appendChild(wrap);

  const decoder = new TextDecoder('utf-8');
  let loaded = 0;
  let total = -1;
  let done = false;
  let busy = false;
  let chunk = CHUNK_SIZE;

  const status = el('span', 'text-more-info');
  const btn = el('button', 'text-more-btn', '继续加载');
  btn.type = 'button';
  foot.appendChild(status);
  foot.appendChild(btn);

  const setBarText = (): void => {
    const nameEl = bar.querySelector('.pb-name');
    const name = nameEl ? nameEl.textContent || '' : '';
    bar.innerHTML = '';
    const s1 = el('span', 'pb-name', name);
    const s2 = el('span', '', `文本 · 已加载 ${humanSize(loaded)}${total >= 0 ? ' / ' + humanSize(total) : ''}`);
    bar.appendChild(s1);
    bar.appendChild(s2);
  };

  async function loadChunk(): Promise<void> {
    if (busy || done) return;
    busy = true;
    try {
      const end = loaded + chunk - 1;
      const res = await fetch(appLocalUrl(path), {
        headers: { Range: `bytes=${loaded}-${end}` }
      });
      if (opts.stale()) return;

      if (!res.ok && res.status !== 206) {
        throw new Error('HTTP ' + res.status);
      }
      const ab = await res.arrayBuffer();
      if (opts.stale()) return;

      // 206 的 Content-Range 形如 "bytes 0-262143/12345678"，末尾就是文件总长
      const cr = res.headers.get('Content-Range');
      if (cr) {
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) total = Number(m[1]);
      } else if (res.status === 200) {
        // 宿主/服务端忽略了 Range：这次拿到的是整个文件
        total = ab.byteLength;
      }

      if (!ab.byteLength) {
        done = true;
      } else {
        loaded += ab.byteLength;
        // stream 模式让不完整的 UTF-8 序列留在解码器里，下一块自动接上
        const text = decoder.decode(new Uint8Array(ab), { stream: total < 0 || loaded < total });
        // 追加文本节点（不重建 innerHTML）：几十 MB 文本也不会触发整体重排
        pre.appendChild(document.createTextNode(text));
        if (ab.byteLength < chunk) done = true;
        if (total >= 0 && loaded >= total) done = true;
      }

      // 大文件读取慢时逐步放大块，减少往返次数
      if (chunk < MAX_CHUNK_SIZE) chunk = Math.min(MAX_CHUNK_SIZE, chunk * 2);

      if (!done) {
        // 先清掉 stream 尾部可能残留的不完整字符（最后一块才 flush）
      } else {
        const tail = decoder.decode();
        if (tail) pre.appendChild(document.createTextNode(tail));
      }

      setBarText();
      foot.style.display = done ? 'none' : 'flex';
      status.textContent = done
        ? `已全部加载（${humanSize(loaded)}）`
        : `已加载 ${humanSize(loaded)}${total >= 0 ? ' / ' + humanSize(total) : ''}，继续向下滚动自动加载`;

      if (done) {
        postToHost({
          type: 'log',
          message: `文本加载完成：${path}（${humanSize(loaded)}，共 ${pre.textContent!.length} 字符）`
        });
      } else {
        // 分块生效的证据：30MB 的电子书首屏只读了 256KB，不再整份进内存
        postToHost({
          type: 'log',
          message: `文本首块已加载：${path}（${humanSize(loaded)}${total >= 0 ? ' / ' + humanSize(total) : ''}，`
            + `滚动到底部继续加载）`
        });
      }
    } catch (e: any) {
      done = true;
      foot.style.display = 'flex';
      status.textContent = '加载失败：' + (e?.message || e);
      throw e;
    } finally {
      busy = false;
    }
  }

  btn.addEventListener('click', () => { void loadChunk().catch(() => { /* 已展示错误 */ }); });

  // 滚动到底部附近自动预取：用户不需要手动点
  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadChunk().catch(() => { /* 已展示错误 */ });
    }, { root: body, rootMargin: `0px 0px ${AUTO_MARGIN} 0px` });
    io.observe(foot);
  }

  // 首块同步等待，保证调用方能拿到"已渲染"的信号
  await loadChunk();
  if (opts.stale()) { if (io) io.disconnect(); return loaded; }

  // 视图被卸载后断开观察，避免继续为一个已经不可见的容器加载
  const tick = window.setInterval(() => {
    if (opts.stale() || !document.body.contains(pre)) {
      if (io) io.disconnect();
      window.clearInterval(tick);
    }
  }, 1000);

  return loaded;
}
