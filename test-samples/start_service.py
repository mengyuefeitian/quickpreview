# -*- coding: utf-8 -*-
"""以普通权限（经 explorer.exe）启动已安装的 QuickPreview 服务。"""
import ctypes, time, subprocess, sys

APP = r"C:\Users\anweining01\AppData\Local\Programs\QuickPreview\QuickPreview.exe"


def is_running():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq QuickPreview.exe"],
                       capture_output=True)
    return b"QuickPreview.exe" in r.stdout


def main():
    if is_running():
        print("已在运行")
        return
    r = ctypes.windll.shell32.ShellExecuteW(
        None, "open", "explorer.exe", '"%s"' % APP, None, 1)
    print("ShellExecute ret", r)
    for i in range(30):
        time.sleep(1)
        if is_running():
            print("已启动（%ds）" % (i + 1))
            return
    print("未能启动")


if __name__ == "__main__":
    main()
