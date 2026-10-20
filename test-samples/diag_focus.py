# -*- coding: utf-8 -*-
"""诊断：当前会话能否取得前台焦点（决定是否可做真实按键端到端测试）"""
import ctypes, time, subprocess
from ctypes import wintypes

u32 = ctypes.WinDLL('user32', use_last_error=True)
k32 = ctypes.WinDLL('kernel32', use_last_error=True)
u32.GetForegroundWindow.restype = wintypes.HWND
u32.GetClassNameW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u32.GetWindowThreadProcessId.restype = wintypes.DWORD


def cls(h):
    b = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, b, 256)
    return b.value


def ttl(h):
    b = ctypes.create_unicode_buffer(512)
    u32.GetWindowTextW(h, b, 512)
    return b.value


wins = []


@ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
def cb(h, l):
    if u32.IsWindowVisible(h) and cls(h) in ('CabinetWClass', 'ExploreWClass'):
        wins.append(h)
    return True


u32.EnumWindows(cb, 0)
print('explorer windows:', [(int(h), ttl(h)[:40]) for h in wins])

if not wins:
    print('打开文件夹…')
    ctypes.windll.shell32.ShellExecuteW(
        None, 'open', r'D:\softDevelop\预览\quick-preview\test-samples', None, None, 1)
    time.sleep(5)
    wins = []
    u32.EnumWindows(cb, 0)
    print('explorer windows:', [(int(h), ttl(h)[:40]) for h in wins])

h = wins[0] if wins else None
print('target hwnd', h)

if h:
    tid_target = u32.GetWindowThreadProcessId(h, None)
    tid_me = k32.GetCurrentThreadId()
    print('tid_me', tid_me, 'tid_target', tid_target)
    print('AttachThreadInput ->', u32.AttachThreadInput(tid_me, tid_target, True))
    print('ShowWindow(SW_SHOW) ->', u32.ShowWindow(h, 5))
    time.sleep(0.3)
    print('SetForegroundWindow ->', u32.SetForegroundWindow(h))
    print('BringWindowToTop ->', u32.BringWindowToTop(h))
    print('SetActiveWindow ->', u32.SetActiveWindow(h))
    time.sleep(1.0)
    fg = u32.GetForegroundWindow()
    print('fg now:', fg, '=>', cls(fg) if fg else None, '|', ttl(fg)[:40] if fg else None)
    print('MATCH:', int(fg or 0) == int(h))
    u32.AttachThreadInput(tid_me, tid_target, False)
