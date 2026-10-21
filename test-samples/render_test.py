# -*- coding: utf-8 -*-
"""
渲染链路测试：用 --preview 入口逐个文件渲染，校验日志中的成功/失败判定。
不需要桌面前台窗口，锁屏下也能跑。
"""
import os, sys, time, subprocess, ctypes
from ctypes import wintypes
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXE = os.environ.get("QP_EXE") or os.path.expanduser(r"~\AppData\Local\Programs\QuickPreview\QuickPreview.exe")
LOGDIR = os.path.expanduser(r"~\AppData\Local\QuickPreview\logs")
SAMPLES = os.path.join(ROOT, "test-samples")
LOGS = ("app.log", "hook.log", "preview.log", "media.log", "web.log", "error.log")

u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.GetClassNameW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
u32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]


def kill_app():
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"],
                   capture_output=True)
    for _ in range(20):
        r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq QuickPreview.exe"],
                           capture_output=True)
        if b"QuickPreview.exe" not in r.stdout:
            return True
        time.sleep(0.3)
    return False


def sizes():
    return {f: (os.path.getsize(os.path.join(LOGDIR, f)) if os.path.exists(os.path.join(LOGDIR, f)) else 0)
            for f in LOGS}


def new_text(before):
    out = {}
    for f in LOGS:
        p = os.path.join(LOGDIR, f)
        if not os.path.exists(p):
            continue
        cur = os.path.getsize(p)
        prev = before.get(f, 0)
        n = max(0, cur - prev)          # 日志倒序：新增内容在文件头部
        if n == 0:
            out[f] = ""
            continue
        for _ in range(6):
            try:
                with open(p, "rb") as fh:
                    out[f] = fh.read(n).decode("utf-8", "ignore")
                break
            except PermissionError:
                time.sleep(0.4)
                out[f] = ""
    return out


def preview_win():
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(h, l):
        if u32.IsWindowVisible(h):
            b = ctypes.create_unicode_buffer(512)
            u32.GetWindowTextW(h, b, 512)
            if b.value.startswith("QuickPreview"):
                found.append(h)
        return True
    u32.EnumWindows(cb, 0)
    return found[0] if found else None


def run_one(path, wait=25.0):
    name = os.path.basename(path)
    kill_app()
    time.sleep(0.6)
    before = sizes()
    subprocess.Popen([EXE, "--preview", os.path.abspath(path)])
    t0 = time.time()
    hwnd = None
    all_new = ""
    while time.time() - t0 < wait:
        if hwnd is None:
            hwnd = preview_win()
        txt = new_text(before)
        all_new = "\n".join(txt.values())
        # 命中"渲染完成：<文件名>"即成功，提前结束；命中真实错误也提前结束
        if ("渲染完成" in all_new and name in all_new) or \
           any("ERROR" in l and "管理员" not in l for l in all_new.splitlines()):
            break
        time.sleep(0.4)
    time.sleep(2.5)          # 等日志缓冲区落盘，避免强杀导致丢日志
    all_new = "\n".join(new_text(before).values())
    kill_app()
    return dict(name=name, shown=hwnd is not None, text=all_new)


KEYS_OK = ("渲染完成", "预览成功")
KEYS_BAD = ("ERROR", "失败", "异常", "不支持")


def judge(name, text):
    lines = [l for l in text.splitlines() if l.strip()]
    ok = [l for l in lines if ("渲染完成" in l) and (name in l)]
    # 测试进程本身被沙箱提权，程序会正常输出管理员告警，属环境噪声不计入失败
    noise = ("管理员权限", "启动即检测到管理员", "日志落盘失败")
    err = [l for l in lines if "ERROR" in l and not any(n in l for n in noise)]
    return ok, err


if __name__ == "__main__":
    files = sys.argv[1:] or ["sample.png", "sample.txt", "sample.docx", "sample.xlsx",
                             "sample.pptx", "sample.pdf", "sample.mp3", "sample.flac",
                             "sample.mp4", "sample.mkv"]
    res = []
    for f in files:
        p = f if os.path.isabs(f) else os.path.join(SAMPLES, f)
        if not os.path.exists(p):
            print(f"[SKIP] 不存在 {p}")
            continue
        r = run_one(p)
        ok, err = judge(r["name"], r["text"])
        passed = r["shown"] and len(ok) > 0 and len(err) == 0
        res.append((r["name"], passed, r["shown"], ok, err))
        print(f"[{'PASS' if passed else 'FAIL'}] {r['name']:<14} 窗口={r['shown']} "
              f"渲染完成={'有' if ok else '无'} 错误={len(err)}")
        for e in err[:3]:
            print("      ! " + e[:180])

    print("\n=========== 汇总 ===========")
    for n, p, s, ok, err in res:
        print(f"[{'PASS' if p else 'FAIL'}] {n}")
    print(f"\n通过 {sum(1 for _, p, _, _, _ in res if p)}/{len(res)}")
