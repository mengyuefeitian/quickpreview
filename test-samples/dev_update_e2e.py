# -*- coding: utf-8 -*-
"""自动更新端到端回归：检查 → 下载 → 校验 → 静默安装 → 重启。

为什么要单独跑这一条：
    "能检查到新版本"和"真的把正在运行的程序换掉再拉起来"是两件事。
    后者要跨三个进程（应用 → 安装程序 → 新应用），任何一环断了，用户看到的现象都是
    "点了更新没反应"或者"更新完程序没了"，而这类失败在纯逻辑测试里根本暴露不出来。

怎么做到可重复：
    · 起一个本地 HTTP 服务当假 GitHub：/release.json 报一个 9.9.9 版本，
      资产指向本机真实安装包（QuickPreview-Setup-1.9.0-x64.exe），带真实 sha256；
    · 应用侧用 QP_UPDATE_API 指向该服务（测试钩子，正常安装包不会设置）；
    · 用 --update-now 走完检查→下载→校验→安装，安装包按 /relaunch=1 重新拉起应用；
    · 断言三处证据：update_check.json 的字段、update_apply.json 的阶段、
      app.log/update.log 里"启动 v1.9.0"与"更新完成"。

用法：
    python test-samples/dev_update_e2e.py [安装包路径]
退出码 0 = 通过，2 = 失败，3 = 环境不具备（未安装 / 安装包缺失）。
"""
import hashlib
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(os.environ["LOCALAPPDATA"], "Programs", "QuickPreview")
APP = os.path.join(APP_DIR, "QuickPreview.exe")
LOGDIR = os.path.join(os.environ["LOCALAPPDATA"], "QuickPreview", "logs")
MOCK_VERSION = "9.9.9"


def latest_installer():
    d = os.path.join(ROOT, "installer")
    if not os.path.isdir(d):
        return None
    exes = [os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".exe")]
    return max(exes, key=os.path.getmtime) if exes else None


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def log_head(name, limit=6000):
    p = os.path.join(LOGDIR, name)
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


def procs():
    """当前 QuickPreview.exe 的 (pid, 启动时间) 列表。"""
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process -Filter \"Name='QuickPreview.exe'\" | "
         "ForEach-Object { \"$($_.ProcessId) $($_.CreationDate.Ticks)\" }"],
        capture_output=True, text=True)
    res = []
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 1 and parts[0].isdigit():
            ticks = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            res.append((int(parts[0]), ticks))
    return res


def kill_app():
    subprocess.run(["taskkill", "/F", "/T", "/IM", "QuickPreview.exe"], capture_output=True)
    time.sleep(1.0)


class Handler(http.server.BaseHTTPRequestHandler):
    installer = None
    installer_name = ""
    payload = b""

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
        if self.path.startswith("/" + self.installer_name):
            size = os.path.getsize(self.installer)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(self.installer, "rb") as f:
                while True:
                    b = f.read(1024 * 256)
                    if not b:
                        break
                    self.wfile.write(b)
            return
        self.send_error(404)


def main():
    setup = sys.argv[1] if len(sys.argv) > 1 else latest_installer()
    if not setup or not os.path.isfile(setup):
        print("找不到安装包，先构建 installer/*.exe")
        return 3
    if not os.path.isfile(APP):
        print("未安装 QuickPreview，先跑 dev_install_check.py。期望路径：" + APP)
        return 3

    name = os.path.basename(setup)
    digest = sha256_of(setup)
    print("安装包：%s（%.1f MB）" % (name, os.path.getsize(setup) / 1048576))
    print("sha256：%s" % digest)

    Handler.installer = setup
    Handler.installer_name = name
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    # 假 Release：版本故意报 9.9.9，内容指向本机的真实安装包
    Handler.payload = json.dumps({
        "tag_name": "v" + MOCK_VERSION,
        "name": "v%s — 自动更新回归（本地模拟）" % MOCK_VERSION,
        "body": "### 新增\n- 自动更新回归用假版本\n\n### 安装\n下载即可。",
        "html_url": "http://127.0.0.1:%d/release.json" % port,
        "draft": False,
        "prerelease": False,
        "published_at": "2026-11-03T00:00:00Z",
        "assets": [{
            "name": name,
            "size": os.path.getsize(setup),
            "digest": "sha256:" + digest,
            "browser_download_url": "http://127.0.0.1:%d/%s" % (port, name),
        }],
    }, ensure_ascii=False).encode("utf-8")

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    api = "http://127.0.0.1:%d/release.json" % port
    print("假 GitHub 接口：%s" % api)

    env = dict(os.environ)
    env["QP_UPDATE_API"] = api
    env.pop("QP_BROWSER_ARGS", None)

    ok = True

    def check(name_, cond, detail=""):
        nonlocal ok
        if cond:
            print("  PASS  " + name_)
        else:
            ok = False
            print("  FAIL  " + name_ + ("  " + detail if detail else ""))

    kill_app()
    before = set(p[0] for p in procs())
    t0 = time.time()

    # ---------- 1. 只检查不安装 ----------
    print("[1] --check-update")
    r = subprocess.run([APP, "--check-update"], env=env, capture_output=True, timeout=120)
    jp = os.path.join(LOGDIR, "update_check.json")
    data = {}
    try:
        data = json.load(open(jp, encoding="utf-8"))
    except Exception as e:
        check("update_check.json 可读", False, str(e))
    check("退出码 0", r.returncode == 0, "rc=%d" % r.returncode)
    check("识别出新版本", data.get("newer") is True, json.dumps(data, ensure_ascii=False)[:200])
    check("版本号 %s" % MOCK_VERSION, data.get("version") == MOCK_VERSION, str(data.get("version")))
    check("挑中安装包", data.get("assetName") == name, str(data.get("assetName")))
    check("解析出 sha256", data.get("sha256") == digest, str(data.get("sha256")))
    check("认得出是安装版", data.get("installed") is True, str(data.get("installed")))

    # ---------- 2. 真的更新 ----------
    print("[2] --update-now（下载 + 校验 + 静默安装）")
    r2 = subprocess.run([APP, "--update-now"], env=env, capture_output=True, timeout=300)
    ap = os.path.join(LOGDIR, "update_apply.json")
    apply = {}
    try:
        apply = json.load(open(ap, encoding="utf-8"))
    except Exception as e:
        check("update_apply.json 可读", False, str(e))
    check("进入安装阶段", apply.get("stage") == "install" and apply.get("ok") is True,
          json.dumps(apply, ensure_ascii=False)[:200])

    ulog = log_head("update.log", 8000)
    check("下载完成", "更新：安装包已就绪" in ulog)
    check("SHA256 校验通过", "SHA256 校验通过" in ulog)

    # ---------- 3. 安装程序重新拉起应用 ----------
    print("[3] 等待安装完成并重启")
    deadline = time.time() + 240
    new_pid = None
    while time.time() < deadline:
        cur = [p for p in procs() if p[0] not in before]
        if cur:
            new_pid = cur[0][0]
            break
        time.sleep(3)
    check("应用被重新拉起", new_pid is not None,
          "等待 %d 秒仍无新进程" % int(time.time() - t0))

    if new_pid is not None:
        # 新实例应带 --updated，启动后 60 秒会记"更新完成"
        deadline2 = time.time() + 150
        announced = False
        started = False
        while time.time() < deadline2:
            time.sleep(5)
            alog = log_head("app.log", 6000)
            if "==== QuickPreview 启动 v1.9.0 ====" in alog:
                started = True
            if "更新完成，当前运行 v1.9.0" in log_head("update.log", 8000):
                announced = True
                break
            if not procs():
                break
        check("新实例版本为 1.9.0", started)
        check("--updated 提示链路生效", announced,
              "未出现『更新完成』日志（可能 --updated 没传进去或 runasoriginaluser 失效）")

        # 安装目录里的 exe 版本必须已经是新的
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-Item '%s').VersionInfo.FileVersion" % APP],
            capture_output=True, text=True)
        check("安装目录 exe 已是 1.9.0", out.stdout.strip().startswith("1.9.0"),
              out.stdout.strip())

    kill_app()
    httpd.shutdown()
    print()
    print("PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
