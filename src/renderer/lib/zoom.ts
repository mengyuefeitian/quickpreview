// 底部缩放控件（PDF / Word 共用）
//
// 约定：value === 0 表示"适应窗口"，>0 表示百分比（100 = 原始尺寸）。
// 控件挂在 .preview-bar（底部条）最右侧，由各 viewer 在重建 bar 时重新挂载。
import { el } from './util';

export interface ZoomControlOptions {
  value: number;
  onChange: (value: number) => void;
  /** 供 +/- 按钮在"适应"与百分比之间换算时参考的实际适应比例 */
  fitPercent?: () => number;
}

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const STEP = 25;

function clampZoom(v: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(v)));
}

/** 在 bar 里追加缩放控件，返回销毁函数（bar 重建后旧节点自然被丢弃） */
export function mountZoomControl(bar: HTMLElement, opts: ZoomControlOptions): () => void {
  const wrap = el('div', 'zoom-ctl');

  const btnOut = el('button', 'zoom-btn', '−');
  btnOut.type = 'button';
  btnOut.title = '缩小';

  const btnFit = el('button', 'zoom-btn zoom-fit', '适应');
  btnFit.type = 'button';
  btnFit.title = '适应窗口（按窗口大小自动缩放）';

  const label = el('span', 'zoom-label', '');
  label.title = '点击在「适应窗口」和 100% 之间切换';

  const btnIn = el('button', 'zoom-btn', '+');
  btnIn.type = 'button';
  btnIn.title = '放大';

  wrap.appendChild(btnOut);
  wrap.appendChild(label);
  wrap.appendChild(btnIn);
  wrap.appendChild(btnFit);
  bar.appendChild(wrap);

  let value = opts.value;

  function paint(): void {
    // 标签永远显示真实比例：处于"适应"时显示当前算出来的适应百分比（如 123%），
    // 否则和右侧「适应」按钮重复成两个"适应"，看不出实际缩放是多少。
    const fit = value === 0;
    const pct = fit ? Math.round(opts.fitPercent ? opts.fitPercent() : 100) : value;
    label.textContent = pct + '%';
    label.classList.toggle('fit', fit);
    btnFit.classList.toggle('active', fit);
    btnOut.classList.toggle('disabled', value !== 0 && value <= MIN_ZOOM);
    btnIn.classList.toggle('disabled', value !== 0 && value >= MAX_ZOOM);
  }

  function apply(next: number): void {
    value = next;
    paint();
    opts.onChange(value);
  }

  // 从"适应"进入百分比时，以当前实际适应比例作为起点，避免突然跳变
  function currentPercent(): number {
    if (value > 0) return value;
    const f = opts.fitPercent ? opts.fitPercent() : 100;
    return clampZoom(f);
  }

  btnOut.addEventListener('click', (e) => {
    e.stopPropagation();
    apply(clampZoom(currentPercent() - STEP));
  });

  btnIn.addEventListener('click', (e) => {
    e.stopPropagation();
    apply(clampZoom(currentPercent() + STEP));
  });

  label.addEventListener('click', (e) => {
    e.stopPropagation();
    apply(value === 0 ? clampZoom(opts.fitPercent ? opts.fitPercent() : 100) : 0);
  });

  btnFit.addEventListener('click', (e) => {
    e.stopPropagation();
    apply(0);
  });

  // 阻止控件区域的滚轮冒泡到 viewer（否则调缩放时会把页面翻走）
  wrap.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  paint();
  return () => { try { wrap.remove(); } catch { /* 忽略 */ } };
}

export { MIN_ZOOM, MAX_ZOOM, clampZoom };
