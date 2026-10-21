# -*- coding: utf-8 -*-
"""预览大文件并观察 __local 请求区间，验证是否流式读取（不再整文件读进内存）。"""
import os
import subprocess
import sys
import time

EXE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "publish", "QuickPreview.exe")
LOGDIR = os.path.expanduser(r"~\AppData\Local\QuickPreview\logs")
MEDIA = os.path.join(LOGDIR, "media.log")

target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test-samples", "big_test.wav")
wait = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0

subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
time.sleep(0.8)
before = os.path.getsize(MEDIA) if os.path.exists(MEDIA) else 0
subprocess.Popen([EXE, "--preview", target])
print("已启动预览，等待 %.0f 秒…" % wait)
time.sleep(wait)
subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
time.sleep(0.6)

cur = os.path.getsize(MEDIA) if os.path.exists(MEDIA) else 0
n = max(0, cur - before)
with open(MEDIA, "rb") as f:
    head = f.read(n).decode("utf-8", "ignore") if n else ""

name = os.path.basename(target)
lines = [l for l in head.splitlines() if "__local" in l]
print("\n%s 的 __local 记录 %d 条：" % (name, len(lines)))
for l in reversed(lines):
    print("  " + l.split("| Media | ")[-1])
