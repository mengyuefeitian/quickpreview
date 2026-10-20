# -*- coding: utf-8 -*-
"""临时脚本：端到端验证预览窗口的拖动 / 缩放 / 记忆（对应 1.5.0 第 4、5 条需求）

做法：真实注入鼠标事件（SetCursorPos + mouse_event）。
两个关键点：
  1. 必须先把窗口切到前台（借助 WebView2 远程调试的 Page.bringToFront），
     否则 injected 点击会落到别的窗口上；
  2. 宿主端的拖动逻辑会检测物理左键是否松开（防止指针移出窗口后收不到 pointerup），
     所以必须用真实按键状态，不能只用 CDP 合成事件。
"""
import ctypes, json, os, subprocess, sys, time
from ctypes import wintypes

EXE = r"D:\softDevelop\预览\quick-preview\publish\QuickPreview.exe"
SAMPLES = r"D:\softDevelop\预览\quick-preview\test-samples"
CONFIG = os.path.join(os.environ["LOCALAPPDATA"], "QuickPreview", "config.json")
NODE = r"C:\Users\anweining01\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
CDP = os.path.join(SAMPLES, "dev_cdp.mjs")

u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
u32.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
u32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
u32.FindWindowW.restype = wintypes.HWND


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def rect(hwnd):
    r = RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def kill():
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(0.9)


def launch():
    env = dict(os.environ)
    env["QP_DEV_CDP_PORT"] = "9222"
    subprocess.Popen([EXE, "--preview", os.path.join(SAMPLES, "multipage.docx")],
                     env=env, creationflags=0x00000008)
    h = None
    for _ in range(90):
        h = u32.FindWindowW(None, "QuickPreview")
        if h and rect(h)[2] > 100:
            break
        time.sleep(0.2)
    if not h:
        raise RuntimeError("窗口没出来")
    time.sleep(1.6)
    subprocess.run([NODE, CDP, "", "__BRING__", "150"], cwd=SAMPLES,
                   capture_output=True, text=True, encoding="utf-8", errors="ignore")
    time.sleep(0.5)
    return h


def drag(x0, y0, x1, y1, steps=14):
    u32.SetCursorPos(x0, y0)
    time.sleep(0.18)
    u32.mouse_event(0x0002, 0, 0, 0, None)          # LEFTDOWN
    time.sleep(0.15)
    for i in range(1, steps + 1):
        u32.SetCursorPos(x0 + int((x1 - x0) * i / steps), y0 + int((y1 - y0) * i / steps))
        time.sleep(0.045)
    time.sleep(0.18)
    u32.mouse_event(0x0004, 0, 0, 0, None)          # LEFTUP
    time.sleep(0.7)


def main():
    kill()
    if os.path.exists(CONFIG):
        os.remove(CONFIG)

    h = launch()

    # 先点一下标题栏把窗口激活：Windows 会吞掉"激活未激活窗口"的那次点击，
    # 不先点一下，第一次拖动会量到位移 0
    r = rect(h)
    u32.SetCursorPos(r[0] + 320, r[1] + 16)
    time.sleep(0.15)
    u32.mouse_event(0x0002, 0, 0, 0, None)
    time.sleep(0.12)
    u32.mouse_event(0x0004, 0, 0, 0, None)
    time.sleep(0.6)

    r0 = rect(h)
    print("起始窗口:", r0)

    # 1) 拖标题栏 → 移动 (+160, +90)
    drag(r0[0] + 320, r0[1] + 16, r0[0] + 480, r0[1] + 106)
    r1 = rect(h)
    print("拖动后:", r1, "位移=", (r1[0] - r0[0], r1[1] - r0[1]))

    # 2) 拖右边框 → 改宽 (+120)
    drag(r1[0] + r1[2] - 3, r1[1] + 240, r1[0] + r1[2] + 117, r1[1] + 240)
    r2 = rect(h)
    print("右边界缩放后:", r2, "宽度变化=", r2[2] - r1[2])

    # 3) 拖底边框 → 改高 (+80)
    drag(r2[0] + 300, r2[1] + r2[3] - 3, r2[0] + 300, r2[1] + r2[3] + 77)
    r3 = rect(h)
    print("下边界缩放后:", r3, "高度变化=", r3[3] - r2[3])

    time.sleep(0.5)
    cfg = {}
    if os.path.exists(CONFIG):
        cfg = json.load(open(CONFIG, encoding="utf-8"))
    print("config.json:", json.dumps(cfg, ensure_ascii=False))

    # 4) 重启验证记忆
    kill()
    h2 = launch()
    r4 = rect(h2)
    print("重启后窗口:", r4)
    kill()

    moved = (r1[0] - r0[0], r1[1] - r0[1])
    wider = r2[2] - r1[2]
    taller = r3[3] - r2[3]
    remembered = (r4 == r3)
    print("\n结论：移动=%s 改宽=%+d 改高=%+d 重启记忆=%s"
          % (moved, wider, taller, remembered))
    return 0 if (moved != (0, 0) and wider > 0 and taller > 0 and remembered) else 1


if __name__ == "__main__":
    sys.exit(main())
