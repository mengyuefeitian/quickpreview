# -*- coding: utf-8 -*-
"""GitHub 辅助脚本：从 env.txt 读 token，做建仓 / 发 Release / 传资产。
用法：
  python dev_gh.py whoami
  python dev_gh.py create <name> <public|private> "<description>"
  python dev_gh.py release <owner/repo> <tag> "<name>" "<body文件>" <资产文件...>
token 只在内存里用，不打印、不落盘。
"""
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

# 本机/公司网络对 github.com 做了 TLS 中间人，系统证书链校验不过（curl 同样要用 -k）
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

ENV_FILE = r"D:\工具管理\env.txt"
API = "https://api.github.com"


def token():
    s = open(ENV_FILE, encoding="utf-8").read()
    m = re.search(r'"GITHUB_PERSONAL_ACCESS_TOKEN"\s*:\s*"([^"]+)"', s)
    if not m:
        raise SystemExit("env.txt 里没找到 GITHUB_PERSONAL_ACCESS_TOKEN")
    return m.group(1)


def call(method, path, body=None, raw=False, ctype="application/json"):
    url = path if path.startswith("http") else API + path
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "QuickPreview-release-script")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=600, context=SSL_CTX) as r:
            buf = r.read()
            return r.status, (buf if raw else json.loads(buf or b"{}"))
    except urllib.error.HTTPError as e:
        buf = e.read()
        try:
            msg = json.loads(buf)
        except Exception:
            msg = buf.decode("utf-8", "ignore")
        return e.code, msg


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"

    if cmd == "whoami":
        st, d = call("GET", "/user")
        if st != 200:
            print("FAIL", st, json.dumps(d, ensure_ascii=False)[:400])
            return 1
        print("login:", d["login"])
        print("name:", d.get("name"))
        print("email:", d.get("email"))
        print("id:", d["id"])
        return 0

    if cmd == "create":
        name, vis, desc = sys.argv[2], sys.argv[3], sys.argv[4]
        st, d = call("POST", "/user/repos", {
            "name": name,
            "description": desc,
            "private": vis == "private",
            "has_issues": True,
            "has_wiki": False,
            "auto_init": False,
        })
        if st not in (200, 201):
            print("FAIL", st, json.dumps(d, ensure_ascii=False)[:600])
            return 1
        print("created:", d["full_name"], d["html_url"], "private=", d["private"])
        print("clone:", d["clone_url"])
        return 0

    if cmd == "release":
        repo, tag, title, bodyfile = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
        assets = sys.argv[6:]
        body = open(bodyfile, encoding="utf-8").read() if bodyfile != "-" else ""
        st, d = call("GET", f"/repos/{repo}/releases/tags/{tag}")
        if st == 404:
            st, d = call("POST", f"/repos/{repo}/releases", {
                "tag_name": tag, "name": title, "body": body, "draft": False, "prerelease": False,
            })
            if st not in (200, 201):
                print("FAIL create release", st, json.dumps(d, ensure_ascii=False)[:600])
                return 1
        elif st != 200:
            print("FAIL query release", st, json.dumps(d, ensure_ascii=False)[:600])
            return 1
        rel = d
        print("release:", rel["html_url"])
        up = rel["upload_url"].split("{")[0]
        for path in assets:
            name = os.path.basename(path)
            data = open(path, "rb").read()
            print(f"uploading {name} ({len(data)/1048576:.1f} MB) ...")
            t0 = time.time()
            st, d2 = call("POST", f"{up}?name={urllib.parse.quote(name)}", data,
                          ctype="application/octet-stream")
            if st not in (200, 201):
                print("FAIL upload", st, json.dumps(d2, ensure_ascii=False)[:400])
                return 1
            print(f"  ok {d2['size']/1048576:.1f} MB, {time.time()-t0:.0f}s -> {d2['browser_download_url']}")
        return 0

    print("unknown cmd")
    return 2


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (release 上传时用到)
    raise SystemExit(main())
