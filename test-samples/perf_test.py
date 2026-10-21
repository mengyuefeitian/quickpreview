# -*- coding: utf-8 -*-
"""逐类型测量：WebView2 初始化耗时、页面 ready 耗时、文件读取耗时、渲染耗时。"""
import os
import re
import sys
import time
import subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXE = os.environ.get("QP_EXE") or os.path.join(ROOT, "publish/QuickPreview.exe")
LOGDIR = os.path.expanduser(r"~\AppData\Local\QuickPreview\logs")
SAMPLES = os.path.join(ROOT, "test-samples")
LOGS = ("app.log", "preview.log", "media.log", "web.log", "error.log")


def kill_app():
    subprocess.run(["taskkill", "/F", "/IM", "QuickPreview.exe"],
                   capture_output=True)
    for _ in range(20):
        r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq QuickPreview.exe"],
                           capture_output=True, text=True, errors="ignore")
        if "QuickPreview.exe" not in (r.stdout or ""):
            return
        time.sleep(0.3)


def sizes():
    return {f: os.path.getsize(os.path.join(LOGDIR, f)) for f in LOGS
            if os.path.exists(os.path.join(LOGDIR, f))}


def new_text(before):
    """日志是倒序写入（最新在文件头部），所以增量在文件【开头】。"""
    out = {}
    for f in LOGS:
        p = os.path.join(LOGDIR, f)
        if not os.path.exists(p):
            continue
        data = b""
        for _ in range(5):
            try:
                with open(p, "rb") as fh:
                    data = fh.read()
                break
            except (PermissionError, OSError):
                time.sleep(0.3)
        old = before.get(f)
        if old is not None and len(data) >= old:
            data = data[: len(data) - old]
        out[f] = data.decode("utf-8", "ignore")
    return out


def run_one(path, wait=30.0):
    name = os.path.basename(path)
    kill_app()
    time.sleep(0.8)
    before = sizes()
    subprocess.Popen([EXE, "--preview", os.path.abspath(path)])
    t0 = time.time()
    while time.time() - t0 < wait:
        txt = "\n".join(new_text(before).values())
        if "渲染完成" in txt or "预览出错" in txt or "回退纯文本" in txt:
            break
        time.sleep(0.5)
    time.sleep(0.6)
    txt = "\n".join(new_text(before).values())
    kill_app()
    return name, txt


PATTERNS = {
    "WebView2就绪": r"WebView2 就绪，耗时 (\d+)ms",
    "页面ready": None,      # 由时间戳差值算出
    "读取": r"读取 .*? 耗时 (\d+) ms",
    "渲染": r"渲染完成：.*?（耗时 (\d+) ms）",
}


def main(files):
    print("EXE =", EXE)
    print(f"{'文件':<16}{'WebView2(ms)':>14}{'页面ready(s)':>14}{'读取(ms)':>10}{'渲染(ms)':>10}  备注")
    print("-" * 88)
    for fn in files:
        p = os.path.join(SAMPLES, fn)
        if not os.path.exists(p):
            print(f"{fn:<16}  样本缺失")
            continue
        name, txt = run_one(p)

        m = re.search(PATTERNS["WebView2就绪"], txt)
        wv = m.group(1) if m else "-"

        # 页面 ready：从"预览引擎已加载"到"预览引擎就绪"的时间差
        t_load = re.search(r"(\d\d:\d\d:\d\d\.\d+).*?预览引擎已加载", txt)
        t_ready = re.search(r"(\d\d:\d\d:\d\d\.\d+).*?预览引擎就绪", txt)
        ready_s = "-"
        if t_load and t_ready:
            def sec(s):
                hh, mm, rest = s.split(":")
                return int(hh) * 3600 + int(mm) * 60 + float(rest)
            d = sec(t_ready.group(1)) - sec(t_load.group(1))
            ready_s = f"{d:.1f}"

        m = re.search(PATTERNS["读取"], txt)
        rd = m.group(1) if m else "-"
        m = re.search(PATTERNS["渲染"], txt)
        rn = m.group(1) if m else "-"

        note = ""
        if "回退纯文本" in txt:
            note = "docx 高保真失败→回退"
        if "预览出错" in txt or "ERROR" in txt.split("\n")[0][:0] + "":
            pass
        if rn == "-":
            note = (note + " 未渲染完成").strip()
        print(f"{name:<16}{wv:>14}{ready_s:>14}{rd:>10}{rn:>10}  {note}")


if __name__ == "__main__":
    files = sys.argv[1:] or ["rich.docx"]
    main(files)
