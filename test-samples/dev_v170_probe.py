# -*- coding: utf-8 -*-
"""v1.7.0 两个改动的真机验证（走 WebView2 + CDP，不需要鼠标模拟）。

用法：
    python test-samples/dev_v170_probe.py

验什么：
  1. 1.5GB 压缩包：不该崩、不该整包读，应给出「按需读取索引」提示并列出条目；
  2. 加密 PDF：预览里出现密码层 → 密码错要提示"密码不正确" → 输入正确密码后
     正常出现 PDF 页面与页码栏。

为什么用 --disable-gpu：本机没有显卡，WebView2 的 GPU 进程会随机把浏览器进程带走，
  这条参数是排查钩子（QP_BROWSER_ARGS），只影响本次测试进程。
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "publish", "QuickPreview.exe")
NODE = "C:/Users/anweining01/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PORT = "9333"
PASSWORD = "qp-secret-2026"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def eval_page(expr):
    env = dict(os.environ, CDP_PORT=PORT)
    r = subprocess.run([NODE, "test-samples/dev_cdp.mjs", "", expr, "200"],
                       cwd=ROOT, capture_output=True, text=True, env=env)
    out = (r.stdout or "") + (r.stderr or "")
    for line in out.splitlines():
        if line.startswith("EVAL "):
            return line[5:].strip()
        if line.startswith("EVAL_ERROR") or line.startswith("TARGET_NOT_FOUND"):
            return "ERR " + line
    return "ERR " + out[-300:]


def launch(path, wait):
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(1.2)
    env = dict(os.environ)
    env["QP_DEV_CDP_PORT"] = PORT
    env["QP_BROWSER_ARGS"] = "--disable-gpu"
    p = subprocess.Popen([EXE, "--preview", os.path.abspath(path), "--quiet"], env=env)
    time.sleep(wait)
    return p


def kill(p):
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    try:
        p.wait(timeout=5)
    except Exception:
        pass


ZIP_EXPR = r"""(() => {
  const q = (s) => document.querySelector(s);
  const notes = Array.from(document.querySelectorAll('.zip-notice')).map((n) => n.textContent.trim());
  return JSON.stringify({
    notices: notes,
    rows: document.querySelectorAll('.zip-row').length,
    meta: q('.zip-meta') ? q('.zip-meta').textContent : '',
    error: q('.error-box') ? q('.error-box').textContent : ''
  });
})()"""

OPEN_ENTRY = r"""(async () => {
  const row = document.querySelector('.zip-row');
  if (!row) return JSON.stringify({ text: '', tip: 'no-row' });
  row.click();
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('.zip-pv-text') || document.querySelector('.zip-pv-tip')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const pre = document.querySelector('.zip-pv-text');
  const tip = document.querySelector('.zip-pv-tip');
  return JSON.stringify({
    text: pre ? pre.textContent : '',
    tip: tip ? tip.textContent : ''
  });
})()"""

PDF_START = r"""(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('.pdf-pass')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const box = document.querySelector('.pdf-pass');
  if (!box) {
    const err = document.querySelector('.error-box');
    return JSON.stringify({ shown: false, error: err ? err.textContent : 'no-dialog' });
  }
  const input = document.querySelector('.pdf-pass-input');
  input.value = 'wrong-password';
  document.querySelector('.pdf-pass-ok').click();
  for (let i = 0; i < 40; i++) {
    const tip = document.querySelector('.pdf-pass-tip');
    if (tip && tip.textContent.indexOf('不正确') >= 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tip = document.querySelector('.pdf-pass-tip');
  return JSON.stringify({
    shown: true,
    title: document.querySelector('.pdf-pass-title').textContent,
    type: input ? input.type : '',
    wrongTip: tip ? tip.textContent.trim() : '',
    locked: input ? input.disabled : null
  });
})()"""

PDF_RETRY = r"""(async () => {
  const input = document.querySelector('.pdf-pass-input');
  if (!input) return JSON.stringify({ retried: false, error: 'no-input' });
  input.value = PW;
  document.querySelector('.pdf-pass-ok').click();
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('.pdf-viewer canvas')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const bar = document.querySelector('.preview-bar');
  const canvas = document.querySelector('.pdf-viewer canvas');
  return JSON.stringify({
    retried: true,
    viewer: !!document.querySelector('.pdf-viewer'),
    canvas: canvas ? canvas.style.width + 'x' + canvas.style.height : '',
    bar: bar ? bar.innerText.replace(/\n/g, ' ') : '',
    dialogLeft: !!document.querySelector('.pdf-pass'),
    error: document.querySelector('.error-box') ? document.querySelector('.error-box').textContent : ''
  });
})()""".replace("PW", json.dumps(PASSWORD))


def main() -> int:
    if not os.path.exists(EXE):
        print("缺少可执行文件：" + EXE)
        return 1

    tmp = tempfile.mkdtemp(prefix="qp170_")
    pdf = os.path.join(tmp, "encrypted.pdf")
    with open(pdf, "wb") as f:
        f.write(load("mep", "test-samples/make_encrypted_pdf.py").build(PASSWORD, "owner-secret"))

    zr = load("zr", "test-samples/dev_zip_range_test.py")
    big = zr.build_sparse(os.path.join(tmp, "big_sparse.zip"))

    fails = []

    def want(cond, text, detail=""):
        print("  [%s] %s%s" % ("PASS" if cond else "FAIL", text, (" — " + detail) if detail else ""))
        if not cond:
            fails.append(text)

    # ---------- 1. 大压缩包 ----------
    print("=" * 72)
    print("1. 1.5GB 压缩包（%s）" % os.path.basename(big))
    p = launch(big, 9.0)
    alive = p.poll() is None
    out = eval_page(ZIP_EXPR)
    try:
        info = json.loads(out)
    except Exception:
        info = {"raw": out}
    print("     页面返回：%s" % json.dumps(info, ensure_ascii=False)[:240])
    want(alive, "进程还活着（没有崩溃退出）")
    want(not info.get("error"), "没有报错框", info.get("error", ""))
    want(info.get("rows", 0) >= 1, "列出了包内条目", "rows=%r" % info.get("rows"))
    want(any("按需读取索引" in n for n in info.get("notices", [])),
         "给出了「按需读取索引」提示", str(info.get("notices")))
    want("1.50 GB" in info.get("meta", ""), "识别出压缩包大小", info.get("meta", ""))

    # 点开包内条目：要走「区间取数据 + DecompressionStream 解压」这条真实通道
    entry = eval_page(OPEN_ENTRY)
    try:
        ei = json.loads(entry)
    except Exception:
        ei = {"raw": entry}
    print("     页面返回：%s" % json.dumps(ei, ensure_ascii=False)[:240])
    want(ei.get("text", "").startswith("quickpreview-sparse-ok"), "点开条目能读出内容",
         repr(ei.get("text", ""))[:80])
    want(ei.get("tip") in (None, ""), "没有出现失败提示", str(ei.get("tip")))
    kill(p)

    # ---------- 2. 加密 PDF ----------
    print("=" * 72)
    print("2. 加密 PDF（%s）" % os.path.basename(pdf))
    p = launch(pdf, 9.0)
    alive = p.poll() is None
    out = eval_page(PDF_START)
    try:
        st = json.loads(out)
    except Exception:
        st = {"raw": out}
    print("     页面返回：%s" % json.dumps(st, ensure_ascii=False)[:240])
    want(alive, "进程还活着")
    want(st.get("shown") is True, "出现密码输入层", st.get("error", ""))
    want(st.get("type") == "password", "输入框是密码类型", st.get("type", ""))
    want("已加密" in st.get("title", ""), "标题说明该 PDF 已加密", st.get("title", ""))
    want("不正确" in st.get("wrongTip", ""), "密码错误时提示「不正确」", st.get("wrongTip", ""))
    want(st.get("locked") is False, "密码错后输入框重新可用", str(st.get("locked")))

    out2 = eval_page(PDF_RETRY)
    try:
        st2 = json.loads(out2)
    except Exception:
        st2 = {"raw": out2}
    print("     页面返回：%s" % json.dumps(st2, ensure_ascii=False)[:240])
    want(st2.get("viewer") is True, "输入正确密码后渲染出 PDF", st2.get("error", ""))
    want(bool(st2.get("canvas")), "首页 canvas 有尺寸", st2.get("canvas", ""))
    want("第 1" in st2.get("bar", ""), "页码栏显示第 1 页", st2.get("bar", ""))
    want(st2.get("dialogLeft") is False, "密码层已移除")
    kill(p)

    print("=" * 72)
    print("失败项：%d" % len(fails))
    for f in fails:
        print("  -", f)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
