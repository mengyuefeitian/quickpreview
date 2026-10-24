# -*- coding: utf-8 -*-
"""真实路径验证：在资源管理器里按 F2 重命名，再按空格，空格必须进到重命名框里。

这个用例直接对应用户上报的 bug：
    重命名时输入法选字要按空格，但全局钩子把空格吞了去开预览，导致改名失败。

判定方式（不猜、看真实控件）：
    1. explorer.exe /select 打开一个临时目录并选中测试文件；
    2. 发 F2 进入重命名；
    3. 读「前台窗口所属线程的焦点控件」——必须是 Edit，记下它此刻的文本；
    4. 发空格；
    5. 焦点控件文本必须多出一个空格，且**不能**弹出 QuickPreview 预览窗。

用法：python test-samples/dev_rename_space_test.py
退出码 0 = 通过；1 = 断言失败；3 = 环境不具备（有程序一直抢前台，F2 到不了资源管理器）。
"""
import ctypes
import os
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get("QP_EXE") or os.path.join(ROOT, "publish", "QuickPreview.exe")

u32 = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

u32.GetForegroundWindow.restype = wintypes.HWND
u32.GetForegroundWindow.argtypes = []
u32.GetClassNameW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u32.GetWindowThreadProcessId.restype = wintypes.DWORD
u32.IsWindowVisible.argtypes = [wintypes.HWND]
u32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

VK_F2 = 0x72
VK_SPACE = 0x20
VK_ESCAPE = 0x1B
KEYEVENTF_KEYUP = 0x0002


class GUITHREADINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("hwndActive", wintypes.HWND), ("hwndFocus", wintypes.HWND),
                ("hwndCapture", wintypes.HWND), ("hwndMenuOwner", wintypes.HWND),
                ("hwndMoveSize", wintypes.HWND), ("hwndCaret", wintypes.HWND),
                ("rcCaret", wintypes.RECT)]


def cls_of(h):
    if not h:
        return ""
    b = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, b, 256)
    return b.value


def text_of(h):
    if not h:
        return ""
    b = ctypes.create_unicode_buffer(1024)
    u32.GetWindowTextW(h, b, 1024)
    return b.value


def focused():
    """前台窗口所属线程的焦点控件。"""
    fg = u32.GetForegroundWindow()
    if not fg:
        return None, None
    tid = u32.GetWindowThreadProcessId(fg, None)
    g = GUITHREADINFO()
    g.cbSize = ctypes.sizeof(GUITHREADINFO)
    if not u32.GetGUIThreadInfo(tid, ctypes.byref(g)):
        return fg, None
    return fg, (g.hwndFocus or fg)


def key(vk):
    u32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.03)
    u32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


ESC = 0x1B
ALT = 0x12


def force_foreground(h, timeout=15.0):
    """把窗口推到前台。

    只调 SetForegroundWindow 会被系统静默拒绝（前台锁），必须先模拟一次 ALT
    按下/抬起解除锁定再试 —— 这是 Windows 的既定行为，跟权限无关。
    """
    t0 = time.time()
    while time.time() - t0 < timeout:
        if int(u32.GetForegroundWindow() or 0) == int(h):
            return True
        try:
            u32.ShowWindow(h, 9 if u32.IsIconic(h) else 5)
        except Exception:
            pass
        # 解除前台锁
        u32.keybd_event(ALT, 0, 0, 0)
        u32.keybd_event(ALT, 0, KEYEVENTF_KEYUP, 0)
        u32.AttachThreadInput(k32.GetCurrentThreadId(), u32.GetWindowThreadProcessId(h, None), True)
        u32.SetForegroundWindow(h)
        u32.BringWindowToTop(h)
        u32.SetFocus(h)
        u32.AttachThreadInput(k32.GetCurrentThreadId(), u32.GetWindowThreadProcessId(h, None), False)
        time.sleep(0.6)
    return False


def preview_visible():
    """是否有可见的 QuickPreview 预览窗（主窗体是隐藏的，出现即代表触发了预览）。"""
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(h, l):
        if u32.IsWindowVisible(h) and cls_of(h).startswith("WindowsForms10.Window"):
            t = text_of(h)
            if t.startswith("QuickPreview"):
                found.append(t)
        return True

    u32.EnumWindows(cb, 0)
    return found


def kill_app():
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(0.8)


def wait_file_count(d, n, timeout=4.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if len(os.listdir(d)) == n:
            return True
        time.sleep(0.2)
    return False


def main():
    if not os.path.exists(EXE):
        print("找不到程序：" + EXE)
        return 2

    tmp = tempfile.mkdtemp(prefix="qprename_")
    target = os.path.join(tmp, "rename_me.txt")
    with open(target, "w", encoding="utf-8") as f:
        f.write("rename test\n")

    kill_app()
    # 后台拉起常驻实例（不带 --preview），让它装上全局钩子
    app = subprocess.Popen([EXE], cwd=os.path.dirname(EXE))
    time.sleep(6)

    fails = []

    def want(cond, label, detail=""):
        print("  [%s] %s%s" % ("PASS" if cond else "FAIL", label, (" — " + detail) if detail else ""))
        if not cond:
            fails.append(label)

    try:
        # 打开目录并选中测试文件
        ctypes.windll.shell32.ShellExecuteW(
            None, "open", "explorer.exe", '/select,"%s"' % target, None, 1)

        hwnd = None
        folder_name = os.path.basename(tmp).lower()      # 窗口标题里只有文件夹名，没有全路径
        t0 = time.time()
        while time.time() - t0 < 15:
            hits = []
            all_titles = []

            @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
            def cb(h, l):
                if cls_of(h) in ("CabinetWClass", "ExploreWClass"):
                    t = text_of(h)
                    all_titles.append(t)
                    if folder_name in t.lower():
                        hits.append(h)
                return True

            u32.EnumWindows(cb, 0)
            if hits:
                hwnd = hits[0]
                break
            time.sleep(0.5)

        want(hwnd is not None, "资源管理器窗口已打开", tmp)
        if hwnd is None:
            print("      已打开的资源管理器窗口标题：" + str(all_titles[:5]))
            return 1

        want(force_foreground(hwnd), "资源管理器已置于前台")
        time.sleep(0.8)

        # 进重命名：本机常驻着截图工具，会时不时把前台抢回去，
        # 所以「置前台 → 发 F2 → 看焦点是不是 Edit」整体重试几次。
        before = ""
        entered = False
        for attempt in range(5):
            if not force_foreground(hwnd, timeout=8.0):
                continue
            key(VK_F2)                     # 确认前台后立刻发键，中间不留空档
            time.sleep(0.45)
            fg, focus = focused()
            if cls_of(focus) == "Edit":
                entered = True
                before = text_of(focus)
                break
            print("      第 %d 次尝试：焦点在 %s，重试" % (attempt + 1, cls_of(focus) or "(空)"))
            key(VK_ESCAPE)
            time.sleep(0.3)

        if not entered:
            # 区分「代码不对」和「按键根本到不了资源管理器」：
            # 本机常驻截图类工具时会不停抢前台，F2 全落到它身上，属于环境问题。
            print("")
            print("环境不具备：连续 5 次 F2 都没能让资源管理器拿到焦点")
            print("（有其它程序在抢前台，例如截图/贴图工具）。关掉它再跑。")
            return 3

        want(entered, "F2 后焦点在重命名框", "重命名框初始文本=%r" % before)

        # 关键的一步：空格
        key(VK_SPACE)
        time.sleep(1.0)
        fg2, focus2 = focused()
        after = text_of(focus2)
        pv = preview_visible()

        want(not pv, "按空格没有弹出预览窗",
             "弹出的窗口：" + str(pv) if pv else "无")
        want(after == before + " ", "空格进到了重命名框里",
             "%r → %r" % (before, after))
        want(os.path.exists(target), "文件没有被改坏（仍在原路径）")

        # 收尾：Esc 取消重命名
        key(VK_ESCAPE)
        time.sleep(0.4)
    finally:
        try:
            u32.PostMessageW(hwnd, 0x0112, 0xF060, 0)      # WM_CLOSE
        except Exception:
            pass
        kill_app()
        try:
            app.wait(timeout=3)
        except Exception:
            pass

    print("")
    print("失败项：%d" % len(fails))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
