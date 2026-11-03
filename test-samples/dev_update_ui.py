# -*- coding: utf-8 -*-
"""自动更新的界面验证：让应用自己发现"新版本"，然后截图看窗口长什么样。

这条用例只做一件事：证明"自动检查 → 弹窗"这条用户可见的路径真的能走通，
并且窗口内容（版本号、更新说明、按钮状态）是对的。逻辑与安装链路由
dev_update_test.py（纯函数）和 dev_update_e2e.py（完整链路）覆盖。

注意：自动检查在启动 60 秒后才跑，所以这里要等 70 秒以上再截图。

用法：
    python test-samples/dev_update_ui.py [输出png]
"""
import http.server
import hashlib
import json
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(os.environ["LOCALAPPDATA"], "Programs", "QuickPreview", "QuickPreview.exe")
CONFIG = os.path.join(os.environ["LOCALAPPDATA"], "QuickPreview", "config.json")
SHOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "test-samples", "_update_ui.png")


def latest_installer():
    d = os.path.join(ROOT, "installer")
    exes = [os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".exe")] if os.path.isdir(d) else []
    return max(exes, key=os.path.getmtime) if exes else ""


class Handler(http.server.BaseHTTPRequestHandler):
    payload = b""
    installer = ""
    installer_path = ""

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/release.json"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(self.payload)))
            self.end_headers()
            self.wfile.write(self.payload)
            return
        # 也把安装包本身喂出去：万一有人手点了「立即更新」，走完整链路而不是 404
        if self.installer and self.path.startswith("/" + self.installer):
            size = os.path.getsize(self.installer_path)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(self.installer_path, "rb") as f:
                while True:
                    b = f.read(1024 * 256)
                    if not b:
                        break
                    self.wfile.write(b)
            return
        self.send_error(404)


def reset_check_time():
    """把"上次检查时间"清掉，否则 6 小时内不会自动检查。"""
    try:
        with open(CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return
    cfg["LastUpdateCheckUtc"] = "0001-01-01T00:00:00"
    cfg["SkipVersion"] = ""
    cfg["SnoozeUntilUtc"] = "0001-01-01T00:00:00"
    cfg["AutoUpdate"] = True
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print("已重置自动检查时间")


def screenshot(path):
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "Add-Type -AssemblyName System.Drawing;"
        "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
        "$g=[System.Drawing.Graphics]::FromImage($bmp);"
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);"
        "$bmp.Save('%s',[System.Drawing.Imaging.ImageFormat]::Png);"
        "Write-Output ('saved ' + $b.Width + 'x' + $b.Height)" % path.replace("\\", "\\\\")
    )
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())


def main():
    if not os.path.isfile(APP):
        print("未安装：" + APP)
        return 3

    setup = latest_installer()
    if not setup:
        print("installer/ 下没有安装包")
        return 3

    h = hashlib.sha256()
    with open(setup, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    setup_sha = h.hexdigest()

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    Handler.installer = "QuickPreview-Setup-1.9.1-x64.exe"
    Handler.installer_path = setup
    Handler.payload = json.dumps({
        "tag_name": "v1.9.1",
        "name": "v1.9.1 — 顺手修了几个小问题",
        "body": ("自动检查发现新版本时，会像这样把更新内容直接摆出来。\n\n"
                 "### 修复\n- 修掉了预览大压缩包时偶发的卡顿\n"
                 "- 重命名框里按空格不再被吞\n\n"
                 "### 安装\n下载 `QuickPreview-Setup-1.9.1-x64.exe` 覆盖安装即可，"
                 "设置与窗口位置保留。逐条变更见 "
                 "[CHANGELOG](https://github.com/mengyuefeitian/quickpreview/blob/main/CHANGELOG.md)。"),
        "html_url": "https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.9.1",
        "draft": False,
        "prerelease": False,
        "published_at": "2026-11-03T09:00:00Z",
        "assets": [{
            "name": "QuickPreview-Setup-1.9.1-x64.exe",
            "size": os.path.getsize(setup),
            "digest": "sha256:" + setup_sha,
            "browser_download_url": "http://127.0.0.1:%d/QuickPreview-Setup-1.9.1-x64.exe" % port,
        }],
    }, ensure_ascii=False).encode("utf-8")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    subprocess.run(["taskkill", "/F", "/T", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(1.5)
    reset_check_time()

    env = dict(os.environ)
    env["QP_UPDATE_API"] = "http://127.0.0.1:%d/release.json" % port
    env["QP_BROWSER_ARGS"] = "--disable-gpu"     # 本机无显卡，避免 WebView2 子进程崩溃干扰
    p = subprocess.Popen([APP], env=env)
    print("已启动应用（pid %d），等待自动检查（约 70 秒）…" % p.pid)

    time.sleep(72)
    screenshot(SHOT)
    print("截图：" + SHOT)

    ulog = os.path.join(os.environ["LOCALAPPDATA"], "QuickPreview", "logs", "update.log")
    try:
        with open(ulog, encoding="utf-8", errors="replace") as f:
            head = f.read(3000)
        for line in head.splitlines()[:12]:
            print("  " + line[:150])
    except OSError:
        print("读不到 update.log")

    if os.environ.get("QP_KEEP_RUNNING") != "1":
        subprocess.run(["taskkill", "/F", "/T", "/IM", "QuickPreview.exe"], capture_output=True)
    httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
