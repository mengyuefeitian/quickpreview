# -*- coding: utf-8 -*-
"""
QuickPreview 真实端到端测试（资源管理器选中文件 → 按空格 → 预览 → 再按空格关闭）

与 render_test.py 的区别：本脚本走的是用户真实路径——
全局键盘钩子 + Shell.Application 读取选中项，而不是 --preview 调试入口。

前置条件：屏幕必须处于解锁状态（存在前台窗口）。
脚本会先等待解锁（默认最多等 30 分钟），再逐个文件测试，结果写入 e2e_result.txt。
"""
import os, sys, time, subprocess, ctypes
from ctypes import wintypes
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.GetForegroundWindow.restype = wintypes.HWND
u32.GetClassNameW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u32.GetWindowThreadProcessId.restype = wintypes.DWORD

VK_SPACE = 0x20
CANDIDATE = {"CabinetWClass", "ExploreWClass", "Progman", "WorkerW",
             "SHELLDLL_DefView", "#32770"}

SAMPLES = os.path.join(ROOT, "test-samples")
LOGDIR = os.path.expanduser(r"~\AppData\Local\QuickPreview\logs")
APP = os.path.expanduser(r"~\AppData\Local\Programs\QuickPreview\QuickPreview.exe")
RESULT = os.path.join(SAMPLES, "e2e_result.txt")
LOGS = ("app.log", "hook.log", "preview.log", "media.log", "web.log", "error.log")

FILES = ["sample.png", "sample.txt", "sample.docx", "sample.xlsx", "sample.pptx",
         "sample.pdf", "sample.mp3", "sample.flac", "sample.ape", "sample.mp4",
         "sample.mkv"]

_log_lines = []


def out(s=""):
    print(s, flush=True)
    _log_lines.append(str(s))
    try:    # 实时落盘，方便随时查看进度
        with open(RESULT, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_log_lines))
    except Exception:
        pass


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


def explorer_hwnds():
    return enum_hwnds(lambda h: u32.IsWindowVisible(h)
                      and cls_of(h) in ("CabinetWClass", "ExploreWClass"))


def preview_hwnd():
    r = enum_hwnds(lambda h: u32.IsWindowVisible(h)
                   and title_of(h).startswith("QuickPreview"))
    return r[0] if r else None


def foreground_ready():
    fg = u32.GetForegroundWindow()
    return fg is not None and cls_of(fg) != ""


def send_space():
    u32.keybd_event(VK_SPACE, 0, 0, 0)
    time.sleep(0.05)
    u32.keybd_event(VK_SPACE, 0, 0x0002, 0)


def sizes():
    return {f: (os.path.getsize(os.path.join(LOGDIR, f))
                if os.path.exists(os.path.join(LOGDIR, f)) else 0) for f in LOGS}


def new_text(before):
    parts = []
    for f in LOGS:
        p = os.path.join(LOGDIR, f)
        if not os.path.exists(p):
            continue
        n = max(0, os.path.getsize(p) - before.get(f, 0))
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


def service_running():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq QuickPreview.exe"],
                       capture_output=True)
    return b"QuickPreview.exe" in r.stdout


def start_service():
    if service_running():
        return True
    ctypes.windll.shell32.ShellExecuteW(None, "open", "explorer.exe",
                                        '"%s"' % APP, None, 1)
    for _ in range(25):
        time.sleep(1)
        if service_running():
            return True
    return False


def force_foreground(h, timeout=15.0):
    """尽力把指定窗口推到前台（AttachThreadInput + 多次尝试）。"""
    k32 = ctypes.windll.kernel32
    t0 = time.time()
    while time.time() - t0 < timeout:
        fg = u32.GetForegroundWindow()
        if fg is not None and int(fg) == int(h):
            return True
        try:
            if u32.IsIconic(h):
                u32.ShowWindow(h, 9)          # SW_RESTORE
            else:
                u32.ShowWindow(h, 5)          # SW_SHOW
        except Exception:
            pass
        tid_t = u32.GetWindowThreadProcessId(h, None)
        tid_m = k32.GetCurrentThreadId()
        u32.AttachThreadInput(tid_m, tid_t, True)
        u32.SetForegroundWindow(h)
        u32.BringWindowToTop(h)
        u32.SetActiveWindow(h)
        u32.AttachThreadInput(tid_m, tid_t, False)
        time.sleep(0.6)
    return False


def wait_unlock(timeout=10800):
    """真正的前置检查：必须能把资源管理器窗口推到前台。
    只有这样才能说明屏幕已解锁、输入可用（不能只看 GetForegroundWindow 非空，
    因为脚本自身的控制台窗口也会被算作前台）。默认最多等 3 小时。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        known = set(explorer_hwnds())
        ctypes.windll.shell32.ShellExecuteW(None, "open", "explorer.exe", SAMPLES, None, 1)
        h, got = None, False
        tw = time.time()
        while time.time() - tw < 15:
            new = [x for x in explorer_hwnds() if x not in known]
            if new:
                h = new[0]
                if force_foreground(h, timeout=10.0):
                    got = True
                break
            time.sleep(0.5)
        if got:
            return h
        if h:
            u32.PostMessageW(h, 0x0112, 0xF060, 0)   # 关掉探测窗口，避免堆积
        out("  …屏幕仍未解锁（无法把资源管理器置为前台），已等待 %d 分钟"
            % int((time.time() - t0) / 60))
        time.sleep(20)
    return None


def test_one(path):
    name = os.path.basename(path)
    before = sizes()
    known = set(explorer_hwnds())

    ctypes.windll.shell32.ShellExecuteW(
        None, "open", "explorer.exe", '/select,"%s"' % os.path.abspath(path), None, 1)

    # 等新窗口出现；出现后若没自动成为前台，主动抢焦点
    target, ok = None, False
    t0 = time.time()
    while time.time() - t0 < 20:
        new = [h for h in explorer_hwnds() if h not in known]
        if new:
            target = new[0]
            fg = u32.GetForegroundWindow()
            if fg is not None and int(fg) == int(target):
                ok = True
                break
            if force_foreground(target, timeout=12.0):
                ok = True
                break
        time.sleep(0.4)

    if not ok:
        if target:
            u32.PostMessageW(target, 0x0112, 0xF060, 0)
        return dict(name=name, ok=False, stage="资源管理器未成为前台窗口",
                    detail="hwnd=%s cls=%s" % (target, cls_of(target)))

    out("    前台已就绪：%s" % title_of(target))
    time.sleep(0.6)
    send_space()

    t0 = time.time()
    ph = None
    while time.time() - t0 < 15:
        ph = preview_hwnd()
        if ph:
            break
        time.sleep(0.25)

    if not ph:
        txt = new_text(before)
        return dict(name=name, ok=False, stage="按空格后预览窗口未出现",
                    detail="\n".join(txt.splitlines()[:10]))

    # 等渲染完成落地
    rendered = False
    t0 = time.time()
    while time.time() - t0 < 25:
        if ("渲染完成" in new_text(before)) and (name in new_text(before)):
            rendered = True
            break
        time.sleep(0.5)

    # 再按一次空格关闭
    send_space()
    closed = False
    t0 = time.time()
    while time.time() - t0 < 8:
        if not preview_hwnd():
            closed = True
            break
        time.sleep(0.25)

    if not closed:
        send_space()
        time.sleep(1.5)
        closed = not preview_hwnd()

    # 关掉本次打开的资源管理器窗口（只关自己开的）
    if target:
        u32.PostMessageW(target, 0x0112, 0xF060, 0)
        time.sleep(0.8)

    txt = new_text(before)
    errs = [l for l in txt.splitlines()
            if "ERROR" in l and "管理员" not in l and "日志落盘" not in l]
    return dict(name=name, ok=bool(rendered and closed), rendered=rendered,
                closed=closed, stage="完成", errors=errs[:3])


def main():
    out("==== QuickPreview 端到端测试 ====")
    out("时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))

    out("前置检查：需要屏幕已解锁（能把资源管理器窗口推到前台）…")
    probe = wait_unlock()
    if not probe:
        out("[中止] 等待 180 分钟仍未解锁，未能执行")
        return 1
    out("屏幕已解锁，输入可用")
    u32.PostMessageW(probe, 0x0112, 0xF060, 0)
    time.sleep(0.8)

    if not start_service():
        out("[中止] 预览服务未运行且无法启动")
        return 1
    out("预览服务已运行")

    results = []
    for f in FILES:
        p = os.path.join(SAMPLES, f)
        if not os.path.exists(p):
            out("[跳过] 不存在 %s" % f)
            continue
        out("\n----- %s -----" % f)
        try:
            r = test_one(p)
        except Exception as e:
            r = dict(name=f, ok=False, stage="异常", detail=str(e))
        results.append(r)
        out("  结果：%s | %s" % ("PASS" if r.get("ok") else "FAIL",
                                r.get("stage", "")))
        for e in r.get("errors", []):
            out("    ! " + e[:160])
        if not r.get("ok") and r.get("detail"):
            out("    " + str(r["detail"])[:300])
        time.sleep(0.8)

    out("\n================= 汇总 =================")
    for r in results:
        extra = (r.get("stage", "") if not r.get("ok")
                 else "渲染=%s 关闭=%s" % (r.get("rendered"), r.get("closed")))
        out("[%s] %-14s %s" % ("PASS" if r.get("ok") else "FAIL", r["name"], extra))
    npass = sum(1 for r in results if r.get("ok"))
    out("\n端到端通过 %d/%d" % (npass, len(results)))
    return 0 if npass == len(results) else 2


if __name__ == "__main__":
    try:
        code = main()
    finally:
        with open(RESULT, "w", encoding="utf-8") as fh:
            fh.write("\n".join(_log_lines))
    sys.exit(code)
