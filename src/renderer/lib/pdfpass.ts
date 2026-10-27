// 加密 PDF 的密码提示层
//
// pdf.js 通过 `onPassword(updatePassword, reason)` 要密码：回调可以被反复调用，
// 第一次 reason=1（需要密码），密码错时 reason=2（密码不正确）。在拿到
// updatePassword 的参数之前，getDocument().promise 一直挂着 —— 所以这里只负责
// 「把输入框画出来、拿到一个字符串」，重试逻辑交给 pdf.js 再次回调。
//
// 取消时用 `updatePassword(new Error(...))` 让 promise 直接 reject，
// 否则「取消」之后 loadingTask 会永远等下去（关掉预览也停不掉 worker）。

import { el } from './util';

/** 与 pdf.js 的 PasswordResponses 对应 */
export const PASSWORD_REASON = { NEED: 1, INCORRECT: 2 } as const;

export interface PasswordPrompt {
  /** 请求一次密码；用户取消时 resolve(null)。 */
  ask(reason: number): Promise<string | null>;
  /** 移除提示层并释放等待中的 promise。 */
  dispose(): void;
}

export function createPasswordPrompt(body: HTMLElement, fileName: string): PasswordPrompt {
  let wrap: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let tip: HTMLElement | null = null;
  let okBtn: HTMLButtonElement | null = null;
  let pending: ((v: string | null) => void) | null = null;

  function settle(v: string | null): void {
    const r = pending;
    pending = null;
    if (v != null) {
      // 交给 pdf.js 去验证：输入框先锁住，避免连点提交两次
      if (input) input.disabled = true;
      if (okBtn) okBtn.disabled = true;
      if (tip) { tip.textContent = '正在验证…'; tip.className = 'pdf-pass-tip'; }
    }
    if (r) r(v);
  }

  function build(): void {
    body.innerHTML = '';
    const box = el('div', 'pdf-pass');
    const card = el('div', 'pdf-pass-card');

    card.appendChild(el('div', 'pdf-pass-icon', '🔒'));
    card.appendChild(el('div', 'pdf-pass-title', '该 PDF 已加密'));
    // 文件名来自磁盘，必须走 textContent，不能拼进 innerHTML
    const nm = el('div', 'pdf-pass-name');
    nm.textContent = fileName;
    card.appendChild(nm);

    const inp = document.createElement('input');
    inp.type = 'password';
    inp.className = 'pdf-pass-input';
    inp.placeholder = '请输入打开密码';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    card.appendChild(inp);

    const t = el('div', 'pdf-pass-tip', '');
    card.appendChild(t);

    const row = el('div', 'pdf-pass-row');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'pdf-pass-ok';
    ok.textContent = '打开';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pdf-pass-cancel';
    cancel.textContent = '取消';
    row.appendChild(ok);
    row.appendChild(cancel);
    card.appendChild(row);

    box.appendChild(card);
    body.appendChild(box);

    wrap = box; input = inp; tip = t; okBtn = ok;

    const submit = (): void => {
      if (!pending) return;
      const v = inp.value;
      if (!v) {
        t.textContent = '请输入密码';
        t.className = 'pdf-pass-tip err';
        inp.focus();
        return;
      }
      settle(v);
    };

    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => settle(null));

    // 输入框里的按键不要冒泡给预览的翻页/缩放处理（方向键、空格、Esc 都在用）
    inp.addEventListener('keydown', (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); settle(null); }
    });
    inp.addEventListener('keyup', (ev: KeyboardEvent) => { ev.stopPropagation(); });
    inp.addEventListener('keypress', (ev: KeyboardEvent) => { ev.stopPropagation(); });
    // 点卡片以外的地方不要关掉预览窗口（浮层内部点击不外传）
    box.addEventListener('mousedown', (ev: MouseEvent) => { ev.stopPropagation(); });
  }

  return {
    ask(reason: number): Promise<string | null> {
      // 上一次请求还挂着就先放开，避免它的 promise 永远悬着
      if (pending) { const p = pending; pending = null; p(null); }
      // 用 body.contains 而不是 isConnected：预览区可能是游离节点（测试里就是），
      // isConnected 只看「在不在 document 里」，游离时会误判成"已被清掉"并重建，
      // 结果重试那一次拿到的是旧输入框引用（看着像没解锁）。
      if (!wrap || !body.contains(wrap)) build();
      if (input) {
        input.disabled = false;
        input.value = '';
        input.focus();
      }
      if (okBtn) okBtn.disabled = false;
      if (tip) {
        const wrong = reason === PASSWORD_REASON.INCORRECT;
        tip.textContent = wrong ? '密码不正确，请重试' : '';
        tip.className = wrong ? 'pdf-pass-tip err' : 'pdf-pass-tip';
      }
      return new Promise<string | null>((resolve) => { pending = resolve; });
    },

    dispose(): void {
      const r = pending;
      pending = null;
      if (r) r(null);
      if (wrap) { try { wrap.remove(); } catch { /* 已被清空 */ } }
      wrap = null; input = null; tip = null; okBtn = null;
    }
  };
}
