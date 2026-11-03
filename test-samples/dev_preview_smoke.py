# -*- coding: utf-8 -*-
"""预览主路径冒烟测试：改过 MainForm / AppConfig 之后确认"按空格预览"没被带坏。

做法：直接跑安装版 `--preview <样本> --quiet`，只看日志里有没有走到「渲染完成」。
本机无显卡时 WebView2 子进程会随机崩（GpuProcessExited），所以用 --disable-gpu；
连跑多轮里只要有一轮成功就说明链路是通的（与既有回归脚本口径一致）。

用法：
    python test-samples/dev_preview_smoke.py
退出码 0 = 至少有一个样本渲染成功。
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(os.environ["LOCALAPPDATA"], "Programs", "QuickPreview", "QuickPreview.exe")
LOGDIR = os.path.join(os.environ["LOCALAPPDATA"], "QuickPreview", "logs")
SAMPLES = ["sample.txt", "sample.pdf", "sample.docx", "sample.xlsx", "sample.zip", "sample.png"]


def log_head(name, limit=8000):
    try:
        with open(os.path.join(LOGDIR, name), encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


def main():
    if not os.path.isfile(APP):
        print("未安装：" + APP)
        return 3

    ok = 0
    for name in SAMPLES:
        path = os.path.join(ROOT, "test-samples", name)
        if not os.path.isfile(path):
            print("  跳过 %-14s（样本不存在）" % name)
            continue

        subprocess.run(["taskkill", "/F", "/T", "/IM", "QuickPreview.exe"], capture_output=True)
        time.sleep(1.0)

        env = dict(os.environ)
        env["QP_BROWSER_ARGS"] = "--disable-gpu"
        p = subprocess.Popen([APP, "--preview", path, "--quiet"], env=env)
        hit = False
        for _ in range(12):
            time.sleep(3)
            head = log_head("preview.log", 4000) + log_head("web.log", 4000)
            if "渲染完成" in head:
                hit = True
                break
            if p.poll() is not None:
                break
        subprocess.run(["taskkill", "/F", "/T", "/IM", "QuickPreview.exe"], capture_output=True)

        print("  %s  %s" % ("PASS" if hit else "FAIL", name))
        if hit:
            ok += 1

    print("\n%d/%d 样本渲染成功" % (ok, len(SAMPLES)))
    return 0 if ok > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
