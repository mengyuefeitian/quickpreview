# -*- coding: utf-8 -*-
"""加密 PDF 的密码流程验证（不需要真实浏览器）。

用法：
    python test-samples/dev_pdf_pass_test.py

两部分：
  A. 真 pdf.js（node 版）跑加密样本，验证 onPassword 的说话方式：
     · 不给密码 → 抛 PasswordException（确认样本真的加密了）
     · 给正确密码 → 正常打开
     · 先给错再给对 → 第二次回调 reason=2（"密码不正确"），最终仍能打开
     · 取消（传 Error）→ promise 直接 reject，不会把 worker 挂住
  B. jsdom 里跑 pdfpass.ts 的提示层：输入、回车、取消、"密码不正确"提示、销毁。

为什么要造样本而不是找现成的：
  本机没有 pypdf/pikepdf，也没有可用的加密 PDF；样本由 make_encrypted_pdf.py
  按 PDF 规范的 Standard security handler（V=1/R=2/40-bit RC4）现场生成。
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASSWORD = "qp-secret-2026"

PDF_PROBE = r"""
const fs = require('fs');
(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const raw = new Uint8Array(fs.readFileSync(process.argv[2]));
  const pw = process.argv[3];
  const copy = () => raw.slice();
  const out = {};

  // 1) 不提供 onPassword：应该直接抛 PasswordException
  try {
    await pdfjs.getDocument({ data: copy(), verbosity: 0 }).promise;
    out.noCallback = 'NO_ERROR';
  } catch (e) {
    out.noCallback = e.name + ': ' + e.message;
  }

  // 2) 正确密码
  {
    const ev = [];
    try {
      const task = pdfjs.getDocument({ data: copy(), verbosity: 0 });
      task.onPassword = (upd, reason) => { ev.push(reason); upd(pw); };
      const doc = await task.promise;
      out.correct = { reasons: ev, pages: doc.numPages };
      await doc.destroy();
    } catch (e) {
      out.correct = { error: e.name + ': ' + e.message, reasons: ev };
    }
  }

  // 3) 先错后对：第二次回调 reason 应为 2
  {
    const ev = [];
    let n = 0;
    try {
      const task = pdfjs.getDocument({ data: copy(), verbosity: 0 });
      task.onPassword = (upd, reason) => {
        ev.push(reason);
        upd(n++ === 0 ? 'wrong-password' : pw);
      };
      const doc = await task.promise;
      out.retry = { reasons: ev, pages: doc.numPages };
      await doc.destroy();
    } catch (e) {
      out.retry = { error: e.name + ': ' + e.message, reasons: ev };
    }
  }

  // 4) 取消：传入 Error 应当让 promise 立即 reject
  {
    const ev = [];
    try {
      const task = pdfjs.getDocument({ data: copy(), verbosity: 0 });
      task.onPassword = (upd, reason) => { ev.push(reason); upd(new Error('已取消输入密码')); };
      await task.promise;
      out.cancel = { error: 'NO_ERROR', reasons: ev };
    } catch (e) {
      out.cancel = { error: e.name + ': ' + e.message, reasons: ev };
    }
  }

  console.log(JSON.stringify(out));
})();
"""

DIALOG_RUNNER = r"""
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
require(process.cwd() + '/test-samples/.pdfpass_bundle.cjs');
const { createPasswordPrompt } = global.__pdfpass;

(async () => {
  const body = document.createElement('div');
  const out = [];
  const ok = (cond, label, detail) => out.push({ ok: !!cond, label, detail: detail || '' });

  const p = createPasswordPrompt(body, '加密样本.pdf');
  ok(!body.querySelector('.pdf-pass'), '初始不显示提示层');

  // 第一次请求：需要密码
  const first = p.ask(1);
  ok(!!body.querySelector('.pdf-pass'), 'ask 后出现密码层');
  ok(body.querySelector('.pdf-pass-name').textContent === '加密样本.pdf', '显示文件名');
  const input = body.querySelector('.pdf-pass-input');
  ok(input && input.type === 'password', '输入框是密码类型');

  // 空密码不放行
  body.querySelector('.pdf-pass-ok').click();
  ok(body.querySelector('.pdf-pass-tip').textContent.indexOf('请输入') >= 0, '空密码时给出提示');

  input.value = 'abc123';
  body.querySelector('.pdf-pass-ok').click();
  ok(await first === 'abc123', '点"打开"返回输入的密码');
  ok(input.disabled === true, '提交后输入框锁定，等验证');

  // 第二次请求：密码错误
  const second = p.ask(2);
  ok(body.querySelector('.pdf-pass-tip').textContent.indexOf('不正确') >= 0, 'reason=2 时提示密码不正确');
  ok(input.disabled === false && input.value === '', '重试时输入框恢复并清空');
  input.value = 'right';
  body.querySelector('.pdf-pass-ok').click();
  ok(await second === 'right', '重试返回新密码');

  // 回车提交
  const third = p.ask(1);
  input.value = 'by-enter';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ok(await third === 'by-enter', '回车可提交');

  // 取消
  const fourth = p.ask(1);
  body.querySelector('.pdf-pass-cancel').click();
  ok(await fourth === null, '取消返回 null');

  // 销毁
  const fifth = p.ask(1);
  p.dispose();
  ok(await fifth === null, '销毁时把等待中的 promise 放开');
  ok(!body.querySelector('.pdf-pass'), '销毁后提示层移除');

  console.log(JSON.stringify(out));
})();
"""


def run(cmd, cwd=ROOT, shell=False):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, shell=shell)


def main() -> int:
    spec = importlib.util.spec_from_file_location(
        "mep", os.path.join(ROOT, "test-samples", "make_encrypted_pdf.py"))
    mep = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mep)

    tmp = tempfile.mkdtemp(prefix="qppdfpw_")
    pdf = os.path.join(tmp, "encrypted.pdf")
    with open(pdf, "wb") as f:
        f.write(mep.build(PASSWORD, "owner-secret"))
    print("样本：%s（%d 字节）" % (pdf, os.path.getsize(pdf)))

    fails = []

    def want(cond, text, detail=""):
        print("  [%s] %s%s" % ("PASS" if cond else "FAIL", text, (" — " + detail) if detail else ""))
        if not cond:
            fails.append(text)

    # ---------- A. pdf.js 层 ----------
    print("=" * 72)
    print("A. pdf.js 的 onPassword 行为")
    probe = os.path.join("test-samples", ".pdf_probe.cjs")
    with open(os.path.join(ROOT, probe), "w", encoding="utf-8") as f:
        f.write(PDF_PROBE)
    r = run(["node", probe, pdf, PASSWORD])
    if r.returncode != 0:
        print(r.stderr[-1500:])
        print("失败项：pdf.js 探测脚本异常")
        return 1
    res = json.loads(r.stdout.strip().splitlines()[-1])

    want("PasswordException" in res["noCallback"], "不提供 onPassword 时抛 PasswordException",
         res["noCallback"])
    want(res["correct"].get("pages") == 1, "正确密码能打开",
         "pages=%r" % res["correct"].get("pages"))
    want(res["correct"].get("reasons") == [1], "首次回调 reason=1",
         str(res["correct"].get("reasons")))
    want(res["retry"].get("pages") == 1, "先错后对最终能打开",
         "pages=%r" % res["retry"].get("pages"))
    want(res["retry"].get("reasons") == [1, 2], "密码错误时第二次回调 reason=2",
         str(res["retry"].get("reasons")))
    # pdf.js 会把传入的 Error 再包成 PasswordException("No password given")，
    # 所以这里只要求"确实被 reject"；把错误翻成人话的是 pdfview.ts（见 dev_preview_probe）。
    want(res["cancel"].get("error", "NO_ERROR") != "NO_ERROR", "取消时 promise 被 reject",
         res["cancel"].get("error"))

    # ---------- B. 提示层 ----------
    print("=" * 72)
    print("B. 密码提示层（jsdom）")
    bundle = os.path.join("test-samples", ".pdfpass_bundle.cjs")
    r = run(["npx", "esbuild", "test-samples/pdfpass_entry.ts", "--bundle", "--format=cjs",
             "--platform=node", "--outfile=" + bundle], shell=True)
    if r.returncode != 0:
        print(r.stderr[-1200:])
        return 1
    runner = os.path.join("test-samples", ".pdfpass_run.cjs")
    with open(os.path.join(ROOT, runner), "w", encoding="utf-8") as f:
        f.write(DIALOG_RUNNER)
    r = run(["node", runner])
    if r.returncode != 0:
        print(r.stderr[-1500:])
        print("失败项：提示层脚本异常")
        return 1
    for item in json.loads(r.stdout.strip().splitlines()[-1]):
        want(item["ok"], item["label"], item["detail"])

    # 清理
    for p in (probe, bundle, runner):
        try:
            os.remove(os.path.join(ROOT, p))
        except OSError:
            pass
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)

    print("=" * 72)
    print("失败项：%d" % len(fails))
    for f in fails:
        print("  -", f)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
