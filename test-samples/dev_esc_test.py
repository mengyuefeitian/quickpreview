# -*- coding: utf-8 -*-
"""验证「页面卡在渲染里时，Esc 还能不能关掉预览」。

背景：大文档渲染的某些段落无法切分（docx-preview 的排版、单节切页），
期间 JS 主线程被占住，自绘的 × 和页面里的 Esc 都排不进事件队列。
宿主键盘钩子不依赖页面，是最后一条逃生通道，必须实测。

流程：程序已在加载大文档 → 把预览窗口调到前台 → 等宿主前台轮询刷新
（_previewActive，700ms 一次）→ 按 Esc → 看窗口是否隐藏。

用法：
  python test-samples/dev_esc_test.py --title QuickPreview
  python test-samples/dev_esc_test.py --title QuickPreview --at 22
"""
import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32

VK_MENU = 0x12
VK_ESCAPE = 0x1B
KEYEVENTF_KEYUP = 0x2

EXPLORER_CLASSES = ("CabinetWClass", "ExploreWClass", "Progman", "WorkerW")


def class_of(h):
    b = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, b, 256)
    return b.value


def title_of(h):
    b = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(h, b, 512)
    return b.value


def find_preview(keyword):
    """找标题含关键字的可见窗口，排除资源管理器与桌面。"""
    hits = []
    Proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        if not user32.IsWindowVisible(h):
            return True
        if keyword in title_of(h) and class_of(h) not in EXPLORER_CLASSES:
            rect = wintypes.RECT()
            user32.GetWindowRect(h, ctypes.byref(rect))
            w, ht = rect.right - rect.left, rect.bottom - rect.top
            if w > 200 and ht > 200:          # 排除标题栏大小的杂窗口
                hits.append(h)
        return True

    user32.EnumWindows(Proc(cb), 0)
    return hits[0] if hits else 0


def tap(vk, hold=0.04):
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(hold)
    user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.2)


def foreground(h):
    user32.keybd_event(VK_MENU, 0, 0, 0)      # 按 ALT 解除前台锁
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.1)
    user32.SetForegroundWindow(h)
    time.sleep(0.5)
    return user32.GetForegroundWindow() == h


def main():
    argv = sys.argv[1:]
    keyword = "QuickPreview"   # 宿主窗口标题固定是 QuickPreview（文件名在页面自绘的标题栏里）
    at = 0
    for i, a in enumerate(argv):
        if a == "--title":
            keyword = argv[i + 1]
        elif a == "--at":
            at = int(argv[i + 1])

    if at:
        time.sleep(at)

    for attempt in range(20):
        h = find_preview(keyword)
        if h:
            break
        time.sleep(0.5)
    if not h:
        print("FAIL 没有找到标题含「%s」的预览窗口" % keyword)
        return 1

    print("找到窗口 0x%X  title=%s" % (h, title_of(h)[:60]))
    fg = foreground(h)
    print("前置结果=%s（需要 True，否则宿主认为预览不在前台，Esc 会被放行）" % fg)
    if not fg:
        print("FAIL 窗口没能到前台，测试无效")
        return 1

    # 宿主的「预览是否前台」是 700ms 轮询维护的，等它刷新
    time.sleep(1.6)
    if not user32.IsWindowVisible(h):
        print("注意：窗口在按 Esc 之前就已经不可见了（可能加载已完成或被别的逻辑关掉）")

    print("按 Esc …")
    tap(VK_ESCAPE)
    time.sleep(1.2)

    visible = bool(user32.IsWindowVisible(h))
    print("RESULT 窗口%s" % ("仍然可见 → FAIL（Esc 没能关掉）" if visible else "已隐藏 → PASS"))
    return 0 if not visible else 1


if __name__ == "__main__":
    sys.exit(main())
