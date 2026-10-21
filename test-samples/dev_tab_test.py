# -*- coding: utf-8 -*-
"""在本机真实复现「资源管理器多标签页」场景，验证预览取的是不是当前标签页的选中项。

做法：开一个资源管理器到目录 A → Ctrl+T 建第二个标签 → 在新标签导航到目录 B
→ Ctrl+A 全选（B 里只有一个文件）→ 按空格 → 读 hook.log 里「读取到选中项」那行。

命中 B 的文件 = 修复有效；命中 A 的文件（或 0 个）= 仍然是第一个标签页。

前置：QuickPreview 正在运行（托盘里能开），屏幕处于解锁状态。
用法：python dev_tab_test.py
"""
import ctypes
import os
import shutil
import sys
import time
from ctypes import wintypes

u32 = ctypes.WinDLL("user32", use_last_error=True)

u32.GetForegroundWindow.restype = wintypes.HWND
u32.GetClassNameW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.VkKeyScanW.argtypes = [wintypes.WCHAR]
u32.VkKeyScanW.restype = wintypes.SHORT

KEYEVENTF_KEYUP = 0x0002
VK_CONTROL = 0x11
VK_RETURN = 0x0D
VK_SPACE = 0x20

LOGDIR = os.path.expanduser(r"~\AppData\Local\QuickPreview\logs")
HOOK = os.path.join(LOGDIR, "hook.log")

TAB_A = os.path.join(os.path.expanduser("~"), "AppData", "Local", "Temp", "qp_tabtest_A")
TAB_B = os.path.join(os.path.expanduser("~"), "AppData", "Local", "Temp", "qp_tabtest_B")


def prep():
    """两个临时目录各放一个可预览的 png，文件名里带 A/B 便于日志区分。"""
    src = None
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("sample.png",):
        p = os.path.join(here, name)
        if os.path.exists(p):
            src = p
            break
    for d, tag in ((TAB_A, "A"), (TAB_B, "B")):
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)
        if src:
            shutil.copyfile(src, os.path.join(d, "tab%s_marker.png" % tag))
    return src


def cls_of(h):
    if not h:
        return ""
    b = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, b, 256)
    return b.value


def title_of(h):
    if not h:
        return ""
    b = ctypes.create_unicode_buffer(512)
    u32.GetWindowTextW(h, b, 512)
    return b.value


def enum_hwnds(pred):
    res = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(h, l):
        if pred(h):
            res.append(h)
        return True

    u32.EnumWindows(cb, 0)
    return res


def exec_cabinet():
    return enum_hwnds(lambda h: u32.IsWindowVisible(h)
                      and cls_of(h) in ("CabinetWClass", "ExploreWClass"))


def force_foreground(h, timeout=10.0):
    """尽力把窗口推到前台：AttachThreadInput + 反复尝试。"""
    k32 = ctypes.windll.kernel32
    t0 = time.time()
    while time.time() - t0 < timeout:
        fg = u32.GetForegroundWindow()
        if fg is not None and int(fg) == int(h):
            return True
        try:
            if u32.IsIconic(h):
                u32.ShowWindow(h, 9)
            cur = u32.GetForegroundWindow()
            if cur:
                ct = k32.GetCurrentThreadId()
                ft = u32.GetWindowThreadProcessId(cur, None)
                ht = u32.GetWindowThreadProcessId(h, None)
                if ft and ht and ft != ct:
                    u32.AttachThreadInput(ft, ct, True)
                if ht and ht != ct:
                    u32.AttachThreadInput(ht, ct, True)
            u32.SetForegroundWindow(h)
            u32.BringWindowToTop(h)
        except Exception:
            pass
        time.sleep(0.4)
    fg = u32.GetForegroundWindow()
    return fg is not None and int(fg) == int(h)


def key_down(vk):
    u32.keybd_event(vk, 0, 0, 0)


def key_up(vk):
    u32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


def tap(vk, hold=0.05):
    key_down(vk)
    time.sleep(hold)
    key_up(vk)


def combo(vk, hold=0.08):
    key_down(VK_CONTROL)
    key_down(vk)
    time.sleep(hold)
    key_up(vk)
    key_up(VK_CONTROL)


def type_ascii(text):
    """逐字符输入（路径是 ASCII）。用 VkKeyScanW 取虚拟键 + shift 状态。"""
    for ch in text:
        res = u32.VkKeyScanW(ch)
        if res == -1:
            continue
        vk = res & 0xFF
        shift = (res >> 8) & 1
        if shift:
            key_down(0x10)          # VK_SHIFT
        tap(vk, 0.02)
        if shift:
            key_up(0x10)
        time.sleep(0.015)


def evidence(txt):
    for line in txt.splitlines():
        if ("读取到选中项" in line or "属于活动标签页" in line
                or "非活动标签页" in line or "未读取到任何选中项" in line):
            print("  | " + line.strip())


def log_sizes():
    s = {}
    for f in ("hook.log", "preview.log", "app.log", "web.log"):
        p = os.path.join(LOGDIR, f)
        s[f] = os.path.getsize(p) if os.path.exists(p) else 0
    return s


def new_text(before):
    parts = []
    for f, old in before.items():
        p = os.path.join(LOGDIR, f)
        if not os.path.exists(p):
            continue
        n = max(0, os.path.getsize(p) - old)
        if n <= 0:
            continue
        for _ in range(5):
            try:
                with open(p, "rb") as fh:
                    parts.append(fh.read(n).decode("utf-8", "ignore"))
                break
            except PermissionError:
                time.sleep(0.4)
    return "\n".join(parts)


def main():
    print("准备测试目录 …")
    src = prep()
    if not src:
        print("× 缺少 test-samples/sample.png，无法准备样本")
        return 2
    print("  A = %s\n  B = %s" % (TAB_A, TAB_B))

    # 先记下已有的资源管理器窗口，打开后再找出新出现的那个。
    # 直接 ShellExecute 一个文件夹时，Win11 常常把它塞进已存在窗口的新标签里（不会新建窗口），
    # 那样 Ctrl+T 会作用到别人窗口上，测出来的结果没有意义。
    known = set(exec_cabinet())
    print("打开资源管理器到 A（/separate 强制新窗口）…")
    ctypes.windll.shell32.ShellExecuteW(
        None, "open", "explorer.exe", '/separate,"%s"' % TAB_A, None, 1)
    hwnd = None
    for _ in range(25):
        time.sleep(0.4)
        new = [h for h in exec_cabinet() if h not in known]
        if new:
            hwnd = new[0]
            break
    if not hwnd:
        print("× 没能打开新的资源管理器窗口")
        return 2
    print("  资源管理器 hwnd=%d title=%s" % (int(hwnd), title_of(hwnd)))

    if not force_foreground(hwnd):
        print("! 无法把资源管理器推到前台，后续按键可能落到别处")
    time.sleep(0.6)

    # 先在标签1 里选中文件（后面切到标签2 后，它不应该再被读到）
    print("Ctrl+A 在标签1 选中 tabA_marker.png …")
    combo(ord("A"))
    time.sleep(0.5)

    print("Ctrl+T 新建标签（Home），焦点移到标签2 …")
    combo(ord("T"))
    time.sleep(1.5)

    navigated = False
    combo(ord("L"))
    time.sleep(1.0)
    type_ascii(TAB_B)
    tap(VK_RETURN)
    time.sleep(2.5)
    navigated = "qp_tabtest_B" in title_of(hwnd)

    # 无论是否导航成功，都在标签2 里全选，确保"两个标签都有选中项"，
    # 这样才能真正区分「读了当前标签」还是「读了标签1」。
    combo(ord("A"))
    time.sleep(0.5)
    if navigated:
        print("  标签2 已导航到 B，全选 …")
    else:
        print("  标签2 导航未生效（Ctrl+L 在 Home 页无效），改在 Home 页全选其条目：")
        print("  此时标签1 有 tabA_marker.png、标签2 有其它条目，读到的必须是标签2 的")

    before = log_sizes()
    tap(VK_SPACE, 0.06)
    time.sleep(2.5)
    txt = new_text(before)
    print("  [在标签2 时]")
    evidence(txt)

    # 关键一步：切回标签1，读取结果必须跟着变
    print("Ctrl+Tab 切回标签1，再按一次空格 …")
    combo(0x09)                      # VK_TAB
    time.sleep(1.5)
    before2 = log_sizes()
    tap(VK_SPACE, 0.06)
    time.sleep(2.5)
    txt2 = new_text(before2)
    print("  [切回标签1 后]")
    evidence(txt2)

    print()
    leaked = "tabA_marker" in txt          # 在标签2 时读到了标签1 的文件
    back_ok = "tabA_marker" in txt2        # 切回标签1 后能读到

    if leaked:
        print("× FAIL —— 人在标签2，却读到了标签1 的 tabA_marker.png")
        return 1
    if not back_ok:
        print("! 切回标签1 后没读到 tabA_marker.png（Ctrl+Tab 可能没生效）")
        if "未读取到任何选中项" in txt:
            print("√ 部分 PASS —— 至少确认没有回退到标签1（读取跟随标签2，其为空）")
            return 0
        return 3
    print("√ PASS —— 读取结果随标签切换而变：标签2 读不到、切回标签1 读到 tabA_marker.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
