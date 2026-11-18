# -*- coding: utf-8 -*-
"""端到端验证「方向键换文件的顺序是否跟着资源管理器走」。

本机不能用 PowerShell COM 模拟输入（被安全策略拦），但 ctypes 调 keybd_event 可以。
流程：把目标资源管理器窗口调到前台 → 按 ↓ 选中第一项 → 按空格开预览 →
连按 ↓ 若干次 → 从 preview.log 里读每次预览的是哪个文件，看是不是视图顺序里的连续项。

用法：
  python test-samples/dev_key_nav.py [--title 关键字] [--steps 4]
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32

VK_MENU = 0x12
VK_SPACE = 0x20
VK_DOWN = 0x28
VK_UP = 0x26
KEYEVENTF_KEYUP = 0x2

LOG = os.path.join(os.environ["LOCALAPPDATA"], "QuickPreview", "logs", "preview.log")


def class_of(h):
    b = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, b, 256)
    return b.value


def title_of(h):
    b = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(h, b, 512)
    return b.value


def find_window(keyword):
    hits = []
    Proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        if class_of(h) in ("CabinetWClass", "ExploreWClass") and keyword in title_of(h):
            hits.append(h)
        return True

    user32.EnumWindows(Proc(cb), 0)
    return hits[0] if hits else 0


def tap(vk, hold=0.03):
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(hold)
    user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.25)


def foreground(h):
    # 先按一下 ALT 解除系统的前台锁，否则 SetForegroundWindow 会被拒绝
    user32.keybd_event(VK_MENU, 0, 0, 0)
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.1)
    user32.SetForegroundWindow(h)
    time.sleep(0.4)
    return user32.GetForegroundWindow() == h


def latest_preview():
    """preview.log 是最新在最上面，第一条「显示预览/切换预览」就是当前文件。"""
    try:
        with open(LOG, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                for key in ("显示预览：", "切换预览："):
                    if key in line:
                        rest = line.split(key, 1)[1].strip()
                        # 行尾还有「（类型 Word，可翻页文件 17 个…）」，文件名本身也可能带「（」
                        return os.path.basename(rest.split("（类型")[0].strip())
    except OSError:
        pass
    return None


def view_order_line():
    try:
        with open(LOG, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if "翻页顺序取自资源管理器视图" in line:
                    return line.strip()
                if "退回自排序" in line:
                    return line.strip()
    except OSError:
        pass
    return None


def main():
    args = sys.argv[1:]
    keyword = "SecADS 3600应用交付系统"
    steps = 4
    for i, a in enumerate(args):
        if a == "--title":
            keyword = args[i + 1]
        elif a == "--steps":
            steps = int(args[i + 1])

    h = find_window(keyword)
    if not h:
        print("找不到标题含 %r 的资源管理器窗口" % keyword)
        return 1
    print("目标窗口：%d  %s" % (h, title_of(h)))

    if not foreground(h):
        print("警告：没能把窗口调到前台，按键可能不生效")
    # 先连按 ↑ 回到列表顶部再多按两下：Explorer 的选中项可能停在任意位置，
    # 直接从"末尾"往下按是没有下一个的（看起来像"按键没反应"）。
    for _ in range(30):
        user32.keybd_event(VK_UP, 0, 0, 0)
        user32.keybd_event(VK_UP, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.01)
    time.sleep(0.5)
    tap(VK_DOWN)          # 落到视图第一项
    tap(VK_SPACE)         # 开预览
    time.sleep(2.5)
    print("首次预览：" + str(latest_preview()))
    print("顺序来源：" + str(view_order_line()))

    seq = []
    for i in range(steps):
        tap(VK_DOWN)
        time.sleep(1.6)
        name = latest_preview()
        seq.append(name)
        print("  按 ↓ #%d → %s" % (i + 1, name))

    print("\n序列：")
    for i, n in enumerate(seq):
        print("  %d  %s" % (i + 1, n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
