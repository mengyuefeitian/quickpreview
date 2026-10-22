"""Check that the preview window is NOT globally topmost.

Why this test exists: v1.6.5 and earlier called TopMost = true on the preview
window (and HWND_TOPMOST in SetWindowPos). That made the window float above
every other application, so the user could not put Word or a second Explorer
window on top to compare files.

This test starts the app in two modes (normal / --quiet) and inspects the
real Win32 extended style bits of the window found by its title.

    WS_EX_TOPMOST    0x00000008   <- must be absent
    WS_EX_NOACTIVATE 0x08000000   <- expected in --quiet mode

Run:  python test-samples/dev_topmost_check.py
"""
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time

EXE = os.environ.get("QP_EXE") or os.path.expanduser(
    r"~\AppData\Local\Programs\QuickPreview\QuickPreview.exe")

user32 = ctypes.WinDLL("user32", use_last_error=True)

GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x00000008
WS_EX_NOACTIVATE = 0x08000000
WS_EX_APPWINDOW = 0x00040000

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def window_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def find_preview_window():
    found = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        if window_title(hwnd) == "QuickPreview":
            found.append(hwnd)
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found


def exstyle(hwnd):
    # GetWindowLongPtrW is 64-bit only; GetWindowLongW works for style bits too
    v = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if v < 0:
        v += 1 << 32
    return v


def file_id_of(hwnd):
    """Return the process id owning the window."""
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def kill_all():
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def probe(label, extra_args):
    kill_all()
    time.sleep(1.0)
    proc = subprocess.Popen(
        [EXE, "--preview", os.path.join(os.path.dirname(__file__), "sample.png")] + extra_args,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    hwnd = None
    deadline = time.time() + 15
    while time.time() < deadline:
        wins = find_preview_window()
        if wins:
            hwnd = wins[0]
            break
        if proc.poll() is not None:
            break
        time.sleep(0.4)

    if hwnd is None:
        print("[%s] FAIL: preview window not found (process alive=%s)"
              % (label, proc.poll() is None))
        return False

    style = exstyle(hwnd)
    topmost = bool(style & WS_EX_TOPMOST)
    noactivate = bool(style & WS_EX_NOACTIVATE)
    fg = user32.GetForegroundWindow()

    ok = not topmost
    print("[%s] hwnd=0x%X pid=%d  exstyle=0x%08X  topmost=%s  noactivate=%s  is_foreground=%s  -> %s"
          % (label, hwnd, file_id_of(hwnd), style, topmost, noactivate,
             fg == hwnd, "PASS" if ok else "FAIL"))
    return ok


def main():
    if not os.path.exists(EXE):
        print("exe not found: " + EXE)
        return 2

    results = []
    results.append(probe("normal", []))
    results.append(probe("quiet", ["--quiet"]))
    kill_all()

    print("")
    print("topmost-free: %d/2" % sum(1 for r in results if r))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
