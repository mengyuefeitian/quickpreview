# -*- coding: utf-8 -*-
"""读预览页真实 DOM，确认单文件网页这条链路端到端跑通。

用法：python test-samples/dev_mhtml_shot.py <file> [out.png]

为什么要走 CDP：本机没有显卡，WebView2 会随机崩，直接看窗口不可靠；
  但只要进程还活着，就能从调试端口拿到页面真实 DOM。
  截图（Page.captureScreenshot）在软件渲染下经常超时，所以默认只读 DOM，
  传了 out.png 才顺带截图（失败不影响结论）。
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get("QP_EXE") or os.path.join(ROOT, "publish", "QuickPreview.exe")
NODE = os.environ.get("QP_NODE") or "node"

PROBE_JS = """
(() => {
  const f = document.querySelector('iframe.mhtml-frame');
  const doc = f && f.contentDocument;   // 沙箱是不透明源，父页面读不到，返回 null 即符合预期
  const bar = document.querySelector('.preview-bar') || document.body;
  return JSON.stringify({
    hasFrame: !!f,
    frameSandbox: f ? f.getAttribute('sandbox') : '',
    srcdocChars: f ? (f.getAttribute('srcdoc') || '').length : 0,
    sandboxIsolated: doc === null,
    bodyText: (bar.textContent || '').trim().slice(0, 120)
  });
})()
"""


def main():
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else ""
    env = dict(os.environ)
    env["QP_DEV_CDP_PORT"] = "9333"
    env.pop("QP_BROWSER_ARGS", None)
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(0.8)
    p = subprocess.Popen([EXE, "--preview", os.path.abspath(path), "--quiet"], env=env)

    env2 = dict(os.environ, CDP_PORT="9333")
    r = subprocess.run([NODE, os.path.join("test-samples", "dev_cdp.mjs"), out, PROBE_JS, "1500"],
                       cwd=ROOT, capture_output=True, text=True, env=env2, shell=True)
    print(r.stdout.strip()[:2000])
    if r.stderr.strip():
        print("STDERR:", r.stderr.strip()[:600])
    alive = p.poll() is None
    print("进程是否还活着：", alive)
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)


if __name__ == "__main__":
    main()
