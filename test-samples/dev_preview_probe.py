# -*- coding: utf-8 -*-
"""打印一次 --preview 期间产生的全部新日志行（不判断成败，只做现场取证）。

用法：python test-samples/dev_preview_probe.py <file> [等待秒数]
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get("QP_EXE") or os.path.expanduser(
    r"~\AppData\Local\Programs\QuickPreview\QuickPreview.exe")
LOGDIR = os.path.expanduser(r"~\AppData\Local\QuickPreview\logs")
LOGS = ("app.log", "hook.log", "preview.log", "media.log", "web.log", "error.log")


def sizes():
    return {f: (os.path.getsize(os.path.join(LOGDIR, f))
                if os.path.exists(os.path.join(LOGDIR, f)) else 0) for f in LOGS}


def new_text(before):
    out = {}
    for f in LOGS:
        p = os.path.join(LOGDIR, f)
        if not os.path.exists(p):
            continue
        n = max(0, os.path.getsize(p) - before.get(f, 0))
        if n == 0:
            continue
        for _ in range(6):
            try:
                with open(p, "rb") as fh:
                    out[f] = fh.read(n).decode("utf-8", "ignore")
                break
            except PermissionError:
                time.sleep(0.4)
    return out


def main():
    path = sys.argv[1]
    wait = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(0.8)
    before = sizes()
    subprocess.Popen([EXE, "--preview", os.path.abspath(path), "--quiet"])
    time.sleep(wait)
    txt = new_text(before)
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    for name in LOGS:
        if name in txt and txt[name].strip():
            print("========== %s ==========" % name)
            # 日志是倒序写的：新增内容在文件头部，读进来就是从新到旧，倒过来按时间正序显示
            lines = [l for l in txt[name].splitlines() if l.strip()]
            for l in reversed(lines):
                print(l)
            print("")


if __name__ == "__main__":
    main()
