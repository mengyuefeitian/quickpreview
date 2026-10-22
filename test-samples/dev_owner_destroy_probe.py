"""Probe: what happens to the preview window when its OWNER Explorer window closes?

Cross-process owner (GWLP_HWNDPARENT) keeps the preview just above that Explorer
window, but Windows destroys owned windows together with their owner. If that
happens here, closing a folder would kill the preview (and maybe the tray app),
so we need to know before relying on it.
"""
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import tempfile
import time

EXE = os.environ.get("QP_EXE") or os.path.expanduser(
    r"~\AppData\Local\Programs\QuickPreview\QuickPreview.exe")
SAMPLES = os.path.dirname(os.path.abspath(__file__))

u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)
u.SetWindowLongPtrW.restype = ctypes.c_void_p
u.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_void_p]
u.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]

EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
GWLP_HWNDPARENT = -8
WM_CLOSE = 0x0010


def class_name(h):
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(h, b, 256)
    return b.value


def title(h):
    n = u.GetWindowTextLengthW(h)
    b = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(h, b, n + 1)
    return b.value


def top_windows():
    out = []

    def cb(h, _):
        if u.IsWindowVisible(h):
            out.append(h)
        return True

    u.EnumWindows(EnumProc(cb), 0)
    return out


def find_title(want):
    for h in top_windows():
        if title(h) == want:
            return h
    return None


def kill(image):
    subprocess.run(["taskkill", "/F", "/IM", image],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    kill("QuickPreview.exe")
    time.sleep(0.8)

    tmp = tempfile.mkdtemp(prefix="qp_owner_probe_")
    before = set(top_windows())
    subprocess.Popen(["explorer.exe", tmp])
    owner = None
    deadline = time.time() + 15
    while time.time() < deadline:
        for h in top_windows():
            if h in before:
                continue
            if class_name(h) in ("CabinetWClass", "ExploreWClass"):
                owner = h
                break
        if owner:
            break
        time.sleep(0.4)
    if not owner:
        print("SKIP cannot open a scratch Explorer window")
        return 0
    print("scratch explorer=0x%X title=%r" % (owner, title(owner)))

    proc = subprocess.Popen([EXE, "--preview", os.path.join(SAMPLES, "sample.png")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    preview = None
    deadline = time.time() + 20
    while time.time() < deadline:
        preview = find_title("QuickPreview")
        if preview:
            break
        time.sleep(0.4)
    if not preview:
        print("FAIL no preview window")
        return 1
    print("preview=0x%X" % preview)

    u.SetWindowLongPtrW(preview, GWLP_HWNDPARENT, ctypes.c_void_p(owner))
    time.sleep(0.6)
    print("owner set, preview alive=%s" % bool(u.IsWindow(preview)))

    print("closing scratch explorer ...")
    u.PostMessageW(owner, WM_CLOSE, 0, 0)
    for i in range(10):
        time.sleep(0.4)
        if not u.IsWindow(owner):
            break
    time.sleep(1.5)

    still_win = bool(preview and u.IsWindow(preview))
    alive = proc.poll() is None
    print("after owner closed: preview_window_alive=%s app_process_alive=%s" % (still_win, alive))

    kill("QuickPreview.exe")
    try:
        os.rmdir(tmp)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
