# -*- coding: utf-8 -*-
"""验证「资源管理器视图顺序」能不能拿到 —— 方向键换文件跳序问题的根因探针。

背景：预览器原来用自己的排序（Directory.GetFiles + Ordinal 排序）决定「下一个文件是谁」，
和资源管理器实际显示的顺序不同，于是按 ↓ 会乱跳。这里验证正宗做法：
  hwnd → SHELLDLL_DefView → DirectUIHWND →(AccessibleObjectFromWindow/NativeOM)→ IShellView
       →(QI)→ IFolderView → ItemCount / Item → PIDL → SHGetNameFromIDList → 路径

用法：
  python test-samples/dev_view_order.py            # 列出所有资源管理器窗口
  python test-samples/dev_view_order.py <hwnd>     # 打印该窗口的视图顺序
"""
import ctypes
import os
import sys
from ctypes import POINTER, byref, c_int, c_long, c_uint, c_ulong, c_void_p, c_wchar_p, wintypes

user32 = ctypes.windll.user32
oleacc = ctypes.windll.oleacc
shell32 = ctypes.windll.shell32
ole32 = ctypes.windll.ole32


class GUID(ctypes.Structure):
    _fields_ = [("Data1", c_uint), ("Data2", ctypes.c_ushort), ("Data3", ctypes.c_ushort),
                ("Data4", ctypes.c_ubyte * 8)]


def guid(s):
    import uuid
    u = uuid.UUID(s)
    g = GUID()
    g.Data1 = u.time_low
    g.Data2 = u.time_mid
    g.Data3 = u.time_hi_version
    for i, b in enumerate(u.bytes[8:]):
        g.Data4[i] = b
    return g


VT = POINTER(POINTER(c_void_p))


def vtable(p):
    return ctypes.cast(p, VT)[0]


def qi(punk, iid):
    fn = ctypes.WINFUNCTYPE(c_long, c_void_p, POINTER(GUID), POINTER(c_void_p))(vtable(punk)[0])
    out = c_void_p()
    hr = fn(punk, byref(iid), byref(out))
    return hr, out


def list_windows():
    res = []
    Proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(h, cls, 256)
        if cls.value in ("CabinetWClass", "ExploreWClass"):
            t = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(h, t, 512)
            res.append((h, t.value))
        return True

    user32.EnumWindows(Proc(cb), 0)
    return res


def class_of(h):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, buf, 256)
    return buf.value


def find_defview(hwnd):
    """Win11 的层级是 CabinetWClass > ShellTabWindowClass > DUIViewWndClassName
    > DirectUIHWND > CtrlNotifySink > SHELLDLL_DefView > DirectUIHWND，
    FindWindowEx 只找直接子窗口，所以必须 EnumChildWindows 递归找。
    多标签页时可能有多个，取可见的那个。"""
    hits = []
    Proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        if class_of(h) == "SHELLDLL_DefView":
            hits.append(h)
        return True

    user32.EnumChildWindows(hwnd, Proc(cb), 0)
    for h in hits:
        if user32.IsWindowVisible(h):
            return h
    return hits[0] if hits else 0


def view_order(hwnd):
    defv = find_defview(hwnd)
    if not defv:
        return None, "找不到 SHELLDLL_DefView"
    dv = 0
    c = user32.GetWindow(defv, 5)      # GW_CHILD
    while c:
        if class_of(c) == "DirectUIHWND":
            dv = c
            break
        c = user32.GetWindow(c, 2)     # GW_HWNDNEXT
    if not dv:
        dv = defv

    iid_sv = guid("000214E3-0000-0000-C000-000000000046")   # IShellView
    oleacc.AccessibleObjectFromWindow.argtypes = [c_void_p, c_ulong, POINTER(GUID), POINTER(c_void_p)]
    oleacc.AccessibleObjectFromWindow.restype = c_long
    psv = c_void_p()
    hr = oleacc.AccessibleObjectFromWindow(c_void_p(dv), c_ulong(0xFFFFFFF0), byref(iid_sv), byref(psv))
    if hr != 0 or not psv:
        return None, "AccessibleObjectFromWindow hr=0x%08X" % (hr & 0xFFFFFFFF)

    iid_fv = guid("cde725b0-ccc9-4519-917e-325d72fab4ce")   # IFolderView
    hr, pfv = qi(psv, iid_fv)
    if hr != 0 or not pfv:
        return None, "QI(IFolderView) hr=0x%08X" % (hr & 0xFFFFFFFF)

    vt = vtable(pfv)
    # vtable: 3 GetCurrentViewMode, 4 SetCurrentViewMode, 5 GetFolder, 6 Item, 7 ItemCount
    ItemCount = ctypes.WINFUNCTYPE(c_long, c_void_p, c_uint, POINTER(c_int))(vt[7])
    Item = ctypes.WINFUNCTYPE(c_long, c_void_p, c_int, POINTER(c_void_p))(vt[6])
    SHGetNameFromIDList = shell32.SHGetNameFromIDList
    SHGetNameFromIDList.argtypes = [c_void_p, c_int, POINTER(c_wchar_p)]
    SHGetNameFromIDList.restype = c_long
    ole32.CoTaskMemFree.argtypes = [c_void_p]

    n = c_int(0)
    if ItemCount(pfv, c_uint(2), byref(n)) != 0:      # SVGIO_ALLVIEW = 0x2
        return None, "ItemCount 失败"
    out = []
    for i in range(n.value):
        pidl = c_void_p()
        if Item(pfv, i, byref(pidl)) != 0 or not pidl:
            continue
        name = c_wchar_p()
        if SHGetNameFromIDList(pidl, 0x80058000, byref(name)) == 0 and name.value:   # SIGDN_DESKTOPABSOLUTEPARSING
            out.append(name.value)
        ole32.CoTaskMemFree(pidl)
    return out, None


def main():
    if len(sys.argv) > 1:
        hwnd = int(sys.argv[1])
        order, err = view_order(hwnd)
        if err:
            print("失败：" + err)
            return 1
        print("视图顺序 %d 项：" % len(order))
        for i, p in enumerate(order):
            print("%3d  %s%s" % (i + 1, os.path.basename(p), "" if os.path.isfile(p) else "  [目录]"))
        return 0

    for h, t in list_windows():
        print("%-10d %s" % (h, t))
    print("\n用法：python test-samples/dev_view_order.py <hwnd>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
