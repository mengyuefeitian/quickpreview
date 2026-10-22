"""Verify the window follows ONLY its own Explorer window (and never floats on top).

Scenarios checked:
  A  right after opening, the preview window is in front (it takes focus on purpose)
  B  user switches back to that Explorer window -> preview is raised above it,
     WITHOUT stealing focus (foreground must stay Explorer)
  C  user switches to a third-party app (Notepad) -> preview stays BELOW it,
     so the user can compare side by side

Before v1.6.6 the window was global topmost, so C would fail: the preview would
still cover Notepad.

Run:  python test-samples/dev_zorder_check.py
"""
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time

EXE = os.environ.get("QP_EXE") or os.path.expanduser(
    r"~\AppData\Local\Programs\QuickPreview\QuickPreview.exe")
SAMPLES = os.path.dirname(os.path.abspath(__file__))

u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)

EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title(hwnd):
    n = u.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def top_windows():
    """Visible top-level windows in z-order, front first."""
    out = []

    def cb(h, _):
        if u.IsWindowVisible(h):
            out.append(h)
        return True

    u.EnumWindows(EnumProc(cb), 0)
    return out


def index_of(hwnd, wins=None):
    wins = wins or top_windows()
    try:
        return wins.index(hwnd)
    except ValueError:
        return -1


def pid_of(hwnd):
    pid = wt.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def find(class_in=None, title_eq=None, title_like=None, pid=None):
    for h in top_windows():
        if pid is not None and pid_of(h) != pid:
            continue
        if class_in and class_name(h) not in class_in:
            continue
        t = title(h)
        if title_eq is not None and t != title_eq:
            continue
        if title_like is not None and title_like not in t:
            continue
        return h
    return None


def force_foreground(hwnd, tries=6):
    """Bring hwnd to the foreground reliably (synthetic ALT releases the lock)."""
    for _ in range(tries):
        if u.GetForegroundWindow() == hwnd:
            return True
        fg = u.GetForegroundWindow()
        tid_fg = u.GetWindowThreadProcessId(fg, None) if fg else 0
        tid_me = k.GetCurrentThreadId()
        attached = False
        if tid_fg and tid_fg != tid_me:
            attached = bool(u.AttachThreadInput(tid_me, tid_fg, True))
        u.keybd_event(0x12, 0, 0, 0)     # ALT down
        u.keybd_event(0x12, 0, 2, 0)     # ALT up
        u.ShowWindow(hwnd, 9)            # SW_RESTORE
        u.SetForegroundWindow(hwnd)
        u.BringWindowToTop(hwnd)
        if attached:
            u.AttachThreadInput(tid_me, tid_fg, False)
        time.sleep(0.35)
    return u.GetForegroundWindow() == hwnd


def kill(image):
    subprocess.run(["taskkill", "/F", "/IM", image],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if not os.path.exists(EXE):
        print("exe not found: " + EXE)
        return 2

    kill("QuickPreview.exe")
    kill("notepad.exe")
    time.sleep(2.0)

    explorer = find(class_in=("CabinetWClass", "ExploreWClass"))
    if not explorer:
        print("SKIP: no Explorer window is open")
        return 0
    print("explorer hwnd=0x%X  fg_ok=%s" % (explorer, force_foreground(explorer)))

    force_foreground(explorer)
    proc = subprocess.Popen([EXE, "--preview", os.path.join(SAMPLES, "sample.png")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    preview = None
    deadline = time.time() + 20
    while time.time() < deadline:
        preview = find(title_eq="QuickPreview", pid=proc.pid)
        if preview:
            break
        time.sleep(0.4)
    if not preview:
        print("FAIL: preview window not found")
        kill("QuickPreview.exe")
        return 1

    time.sleep(2.0)
    ok = []
    print("state: visible=%s owner=0x%X hwnd=0x%X"
          % (bool(u.IsWindowVisible(preview)), u.GetWindow(preview, 4), preview))

    # ---- A: opened window is in front
    wins = top_windows()
    a_front = index_of(preview, wins) < index_of(explorer, wins)
    print("A open-in-front      : preview_idx=%d explorer_idx=%d fg_self=%s -> %s"
          % (index_of(preview, wins), index_of(explorer, wins),
             u.GetForegroundWindow() == preview, "PASS" if a_front else "FAIL"))
    ok.append(a_front)

    # ---- B: back to the owning Explorer window -> raised above it, no focus steal
    force_foreground(explorer)
    time.sleep(1.8)
    wins = top_windows()
    pi, ei = index_of(preview, wins), index_of(explorer, wins)
    b_above = 0 <= pi < ei
    b_no_steal = u.GetForegroundWindow() == explorer
    print("B follow-explorer    : preview_idx=%d explorer_idx=%d fg_is_explorer=%s -> %s"
          % (pi, ei, b_no_steal, "PASS" if (b_above and b_no_steal) else "FAIL"))
    ok.append(b_above and b_no_steal)

    # ---- C: switch to a third-party app -> preview must stay below it
    note = subprocess.Popen(["notepad.exe", os.path.join(SAMPLES, "sample.txt")])
    notepad = None
    deadline = time.time() + 12
    while time.time() < deadline:
        notepad = find(class_in=("Notepad", "ApplicationFrameWindow"), title_like="sample.txt")
        if notepad:
            break
        time.sleep(0.4)

    if not notepad:
        print("C below-other-app    : SKIP (notepad window not found)")
    else:
        force_foreground(notepad)
        time.sleep(1.8)
        wins = top_windows()
        pi, ni = index_of(preview, wins), index_of(notepad, wins)
        c_below = ni >= 0 and pi > ni
        c_fg = u.GetForegroundWindow() == notepad
        print("C below-other-app    : preview_idx=%d notepad_idx=%d fg_is_notepad=%s -> %s"
              % (pi, ni, c_fg, "PASS" if (c_below and c_fg) else "FAIL"))
        ok.append(c_below and c_fg)

    kill("notepad.exe")
    kill("QuickPreview.exe")
    if proc.poll() is None:
        proc.terminate()

    print("")
    print("z-order behaviour: %d/%d" % (sum(1 for r in ok if r), len(ok)))
    return 0 if all(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
