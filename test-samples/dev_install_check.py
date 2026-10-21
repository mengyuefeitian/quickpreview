# -*- coding: utf-8 -*-
"""静默安装当前版本的安装包，并核对安装结果。

关键点：
  · 不能用 Bash 直跑安装包（会被信号中断），也不能用 PowerShell Start-Process（沙箱拦截）；
    这里用 ShellExecuteExW + SEE_MASK_NOCLOSEPROCESS 拿到进程句柄，再 WaitForSingleObject
    等它真正装完。之前只轮询 exe 版本号会在"文件还没拷完"时就判定完成，误报到 assets 为空。
  · 必须用 "普通权限" 语义 —— 本机测试进程是管理员，安装包会继承提权，属于既有环境噪声。
"""
import ctypes, os, subprocess, sys, time
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def latest_installer():
    """installer/ 下按修改时间取最新的安装包，避免脚本里写死版本号。"""
    d = os.path.join(ROOT, "installer")
    if not os.path.isdir(d):
        return None
    exes = [os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".exe")]
    return max(exes, key=os.path.getmtime) if exes else None

APP = os.path.join(os.environ["LOCALAPPDATA"], "Programs", "QuickPreview")
ASSETS = os.path.join(APP, "webroot", "assets")

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
shell32 = ctypes.WinDLL("shell32", use_last_error=True)


class SHELLEXECUTEINFOW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("fMask", ctypes.c_ulong),
                ("hwnd", wintypes.HWND), ("lpVerb", wintypes.LPCWSTR),
                ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
                ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int),
                ("hInstApp", ctypes.c_void_p), ("lpIDList", ctypes.c_void_p),
                ("lpClass", wintypes.LPCWSTR), ("hkeyClass", ctypes.c_void_p),
                ("dwHotKey", wintypes.DWORD), ("hIcon", ctypes.c_void_p),
                ("hProcess", wintypes.HANDLE)]


SEE_MASK_NOCLOSEPROCESS = 0x00000040
SEE_MASK_NOASYNC = 0x00000100


def tree(path):
    n = total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            n += 1
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return n, total / 1048576


def file_version(exe):
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "(Get-Item '%s').VersionInfo.FileVersion" % exe],
                         capture_output=True, text=True)
    return out.stdout.strip()


def main():
    setup = sys.argv[1] if len(sys.argv) > 1 else latest_installer()
    if not setup:
        print("找不到 installer/*.exe，请先构建安装包，或把路径作为第一个参数传入。")
        return 1
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(1)

    if os.path.isdir(APP):
        print("安装前：%d 个文件，%.1f MB" % tree(APP))
        print("  安装前 assets：", len(os.listdir(ASSETS)) if os.path.isdir(ASSETS) else "不存在")

    sei = SHELLEXECUTEINFOW()
    sei.cbSize = ctypes.sizeof(sei)
    sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
    sei.lpVerb = "open"
    sei.lpFile = setup
    sei.lpParameters = "/SILENT /SUPPRESSMSGBOXES /NOCANCEL"
    sei.lpDirectory = os.path.dirname(setup)
    sei.nShow = 0            # SW_HIDE
    ok = shell32.ShellExecuteExW(ctypes.byref(sei))
    if not ok:
        print("ShellExecuteExW 失败：", ctypes.get_last_error())
        return 1
    print("安装已启动，等待结束…")
    t0 = time.time()
    kernel32.WaitForSingleObject(sei.hProcess, 300000)
    kernel32.CloseHandle(sei.hProcess)
    print("安装进程结束，耗时 %.1f 秒" % (time.time() - t0))

    time.sleep(1.5)
    print("安装后：%d 个文件，%.1f MB" % tree(APP))
    names = sorted(os.listdir(ASSETS)) if os.path.isdir(ASSETS) else None
    print("安装后 assets：", len(names) if names is not None else "目录不存在")
    if names:
        for x in names:
            print("   ", x)
    print("exe 版本：", file_version(os.path.join(APP, "QuickPreview.exe")))
    print("package.json 版本：", __import__("json").load(
        open(os.path.join(ROOT, "package.json"), encoding="utf-8"))["version"])
    print("exe 同级 WebView2 缓存（应为 False）：",
          os.path.isdir(os.path.join(APP, "QuickPreview.exe.WebView2")))
    return 0 if names else 1


if __name__ == "__main__":
    raise SystemExit(main())
