# -*- coding: utf-8 -*-
"""临时脚本：以远程调试端口启动 QuickPreview（--preview 某个文件），不等待退出。"""
import os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "publish", "QuickPreview.exe")
SAMPLES = os.path.join(ROOT, "test-samples")

target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SAMPLES, "multipage.docx")
if not os.path.isabs(target):
    target = os.path.join(SAMPLES, target)

subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
time.sleep(0.8)

env = dict(os.environ)
env["QP_DEV_CDP_PORT"] = "9222"
subprocess.Popen([EXE, "--preview", target], env=env,
                 creationflags=0x00000008)   # DETACHED_PROCESS
time.sleep(3.5)
print("launched:", target)
