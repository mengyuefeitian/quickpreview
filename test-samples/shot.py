# -*- coding: utf-8 -*-
"""预览窗口截图工具（纯标准库：ctypes 抓屏 + 手写 PNG 编码）

用法：
    python test-samples/shot.py <exe> <要预览的文件> <输出.png> [等待秒数] [稳定秒数]

注意：WebView2 走 DirectComposition，PrintWindow 抓到的是空白，
必须先把窗口置前再 BitBlt 屏幕 DC。因此需要会话已解锁（有可见桌面）。
"""
import ctypes
import os
import struct
import subprocess
import sys
import time
import zlib
from ctypes import wintypes


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


u32 = ctypes.WinDLL("user32", use_last_error=True)
g32 = ctypes.WinDLL("gdi32", use_last_error=True)

u32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
u32.FindWindowW.restype = wintypes.HWND
u32.IsWindowVisible.argtypes = [wintypes.HWND]
u32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
u32.SetForegroundWindow.argtypes = [wintypes.HWND]
u32.GetDC.restype = wintypes.HDC
u32.GetDC.argtypes = [wintypes.HWND]
u32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]

g32.CreateCompatibleDC.restype = wintypes.HDC
g32.CreateCompatibleDC.argtypes = [wintypes.HDC]
g32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
g32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
g32.SelectObject.restype = wintypes.HGDIOBJ
g32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
g32.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                       ctypes.c_int, wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
g32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
g32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
g32.DeleteDC.argtypes = [wintypes.HDC]

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


def write_png(path, width, height, rgb_rows):
    """rgb_rows: 每行 bytes，长度 = width*3"""
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rgb_rows)   # filter type 0
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def grab(hwnd, out_png):
    r = RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    if w <= 0 or h <= 0:
        raise RuntimeError("窗口尺寸异常 %dx%d" % (w, h))

    hdc_screen = u32.GetDC(None)
    hdc_mem = g32.CreateCompatibleDC(hdc_screen)
    hbmp = g32.CreateCompatibleBitmap(hdc_screen, w, h)
    g32.SelectObject(hdc_mem, hbmp)
    g32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, r.left, r.top, SRCCOPY)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                    ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                    ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h          # 负值 = 自上而下，省得翻转
    bi.biPlanes = 1
    bi.biBitCount = 24
    bi.biCompression = 0

    stride = ((w * 3 + 3) // 4) * 4
    buf = ctypes.create_string_buffer(stride * h)
    got = g32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)
    if got == 0:
        raise RuntimeError("GetDIBits 失败")

    data = buf.raw
    rows = []
    for y in range(h):
        row = data[y * stride: y * stride + w * 3]
        # BMP 是 BGR，PNG 要 RGB
        rows.append(bytes(b for i in range(0, len(row), 3)
                          for b in (row[i + 2], row[i + 1], row[i])))
    write_png(out_png, w, h, rows)

    g32.DeleteObject(hbmp)
    g32.DeleteDC(hdc_mem)
    u32.ReleaseDC(None, hdc_screen)
    return w, h


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    exe, target, out = sys.argv[1], sys.argv[2], sys.argv[3]
    wait = float(sys.argv[4]) if len(sys.argv) > 4 else 15.0
    settle = float(sys.argv[5]) if len(sys.argv) > 5 else 5.0

    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(0.8)
    subprocess.Popen([exe, "--preview", os.path.abspath(target)])

    hwnd = None
    t0 = time.time()
    while time.time() - t0 < wait:
        h = u32.FindWindowW(None, "QuickPreview")
        if h and u32.IsWindowVisible(h):
            hwnd = h
            break
        time.sleep(0.2)
    if not hwnd:
        print("WINDOW_NOT_FOUND")
        return 1

    time.sleep(settle)
    u32.SetForegroundWindow(hwnd)
    time.sleep(0.8)
    w, h = grab(hwnd, out)
    print("saved %s (%dx%d)" % (out, w, h))
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"], capture_output=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
