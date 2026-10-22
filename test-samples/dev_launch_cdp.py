# -*- coding: utf-8 -*-
"""启动 publish 版 QuickPreview 并打开 --preview，同时开启 CDP 调试端口。
用法：python dev_launch_cdp.py <文件路径> [端口]
"""
import os, sys, time, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get("QP_EXE") or os.path.join(ROOT, "publish", "QuickPreview.exe")

def main():
    path = os.path.abspath(sys.argv[1])
    port = sys.argv[2] if len(sys.argv) > 2 else "9222"
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(0.8)
    env = dict(os.environ)
    env["QP_DEV_CDP_PORT"] = port
    p = subprocess.Popen([EXE, "--preview", path, "--quiet"], env=env)
    print("PID", p.pid, "PORT", port)

if __name__ == "__main__":
    main()
