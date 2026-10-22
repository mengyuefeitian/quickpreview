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

# Release 正文长度限制：CHANGELOG 可以写细，GitHub 的发布说明只写用户能感知的变化。
# 早期版本越写越长（v1.6.6 一度到 2830 字），用户明确要求言简意赅，故在发布前拦一道。
NOTE_SOFT_LIMIT = 1200      # 超过打警告
NOTE_HARD_LIMIT = 1600      # 超过直接拒绝发布

# 标题统一为 "vX.Y.Z — 主题"：小写 v、空格+破折号+空格、主题 8~22 字、不带产品名。
# 规范见 docs/releases/_TEMPLATE.md，检查脚本 test-samples/check_release_notes.py。
TITLE_RE = re.compile(r"^v\d+\.\d+\.\d+ — \S.{5,23}$")


def check_note(name, body):
    """按发布说明规范校验，返回错误描述；合规返回 None。"""
    if name is not None:
        if not TITLE_RE.match(name or ""):
            return "title must look like 'vX.Y.Z — <8~22 chars subject>' (em dash with spaces)"
        if "QuickPreview" in name:
            return "title must not repeat the product name (the page already shows it)"
    if "### 安装" not in body:
        return "body must contain a '### 安装' section"
    if "CHANGELOG" not in body:
        return "body must link to CHANGELOG at the end"
    first = (body.strip().splitlines() or [""])[0]
    if first.startswith("#"):
        return "body must start with a one-line summary, not a heading"
    return None


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

        # 长度守卫：详细内容放 CHANGELOG，Release 只保留几条要点
        n = len(body)
        if n > NOTE_HARD_LIMIT:
            print("REFUSED: release body is %d chars (hard limit %d)." % (n, NOTE_HARD_LIMIT))
            print("Keep only what users can notice; move the details into CHANGELOG.md.")
            print("Template: docs/releases/_TEMPLATE.md")
            return 1
        if n > NOTE_SOFT_LIMIT:
            print("WARN: release body is %d chars (> %d), consider trimming."
                  % (n, NOTE_SOFT_LIMIT))

        err = check_note(title, body)
        if err:
            print("REFUSED: " + err)
            print("Template: docs/releases/_TEMPLATE.md")
            return 1

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

    if cmd == "body":
        # 只改某次 Release 的正文（改文案后同步，不必重新上传资产）
        repo, tag, bodyfile = sys.argv[2], sys.argv[3], sys.argv[4]
        body = open(bodyfile, encoding="utf-8").read()
        n = len(body)
        if n > NOTE_HARD_LIMIT:
            print("REFUSED: release body is %d chars (hard limit %d)." % (n, NOTE_HARD_LIMIT))
            return 1
        if n > NOTE_SOFT_LIMIT:
            print("WARN: release body is %d chars (> %d), consider trimming."
                  % (n, NOTE_SOFT_LIMIT))
        err = check_note(None, body)
        if err:
            print("REFUSED: " + err)
            return 1
        st, d = call("GET", f"/repos/{repo}/releases/tags/{tag}")
        if st != 200:
            print("FAIL query release", st, json.dumps(d, ensure_ascii=False)[:400])
            return 1
        st, d2 = call("PATCH", f"/repos/{repo}/releases/{d['id']}", {"body": body})
        if st != 200:
            print("FAIL patch release", st, json.dumps(d2, ensure_ascii=False)[:400])
            return 1
        print("updated %s: %d -> %d chars" % (tag, len(d.get("body") or ""), len(d2.get("body") or "")))
        print(d2["html_url"])
        return 0

    print("unknown cmd")
    return 2


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (release 上传时用到)
    raise SystemExit(main())
