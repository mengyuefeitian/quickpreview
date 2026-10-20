# -*- coding: utf-8 -*-
"""对若干 docx 逐个起预览、统计页眉页脚覆盖情况（需要 CDP 端口）。"""
import os, sys, time, subprocess, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "publish", "QuickPreview.exe")
NODE = r"C:\Users\anweining01\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
PY = r"C:\Users\anweining01\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
PROBE = os.path.join(ROOT, "test-samples", "_hf_summary.js")
EVAL = os.path.join(ROOT, "test-samples", "dev_eval.mjs")


def kill():
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(0.7)


def run(path, wait=9.0):
    kill()
    env = dict(os.environ)
    env["QP_DEV_CDP_PORT"] = "9222"
    subprocess.Popen([EXE, "--preview", os.path.abspath(path)], env=env)
    time.sleep(wait)
    r = subprocess.run([NODE, EVAL, PROBE, "1200"], capture_output=True, text=True, timeout=120)
    return (r.stdout or r.stderr).strip().replace("\n", " / ")


if __name__ == "__main__":
    files = sys.argv[1:]
    for f in files:
        name = os.path.basename(f)
        try:
            print(f"[{name}]\n  {run(f)}")
        except Exception as e:
            print(f"[{name}] 失败 {e}")
    kill()
