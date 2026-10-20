# -*- coding: utf-8 -*-
"""一键发布：建仓（若无）→ push main → 建 Release → 上传安装包。

token 从 D:\\工具管理\\env.txt 的 GITHUB_PERSONAL_ACCESS_TOKEN 读取，只在内存里用。
用法：
  python dev_publish.py            # 全流程
  python dev_publish.py status     # 只看当前进度（不写入任何东西）

前置要求：token 必须具备
  - Contents        : Read and write   （push / Release / 传资产）
  - Administration  : Read and write   （只在"需要新建仓库"时才要）
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dev_gh as g  # noqa: E402

OWNER = "mengyuefeitian"
REPO = "quick-preview"
FULL = f"{OWNER}/{REPO}"
TAG = "v1.5.3"
TITLE = "QuickPreview 1.5.3"
DESC = "Windows 空格键快速预览工具 —— 选中文件按空格即可原生渲染 docx/pptx/xlsx/pdf/图片/音视频"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALLER = os.path.join(ROOT, "installer", "QuickPreview-Setup-1.5.3-x64.exe")
NOTES = os.path.join(ROOT, "docs", "release-notes-1.5.3.md")


def sh(args, **kw):
    print("$", " ".join(a if "@" not in a else "<redacted>" for a in args))
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="ignore", **kw)
    out = (p.stdout or "") + (p.stderr or "")
    if out.strip():
        print(out.strip()[-1500:])
    return p.returncode


def status():
    st, d = g.call("GET", f"/repos/{FULL}")
    print("repo:", st, d.get("full_name") if st == 200 else json.dumps(d, ensure_ascii=False)[:200])
    if st == 200:
        print("  url:", d["html_url"], "private=", d["private"], "size(KB)=", d.get("size"))
        st2, r = g.call("GET", f"/repos/{FULL}/releases/tags/{TAG}")
        print("  release:", st2, (r.get("html_url") if st2 == 200 else "-"))
    return st == 200


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        status()
        return 0

    # 0) 产物检查
    for p in (INSTALLER, NOTES):
        if not os.path.exists(p):
            print("缺文件:", p)
            return 1
    print("安装包 %.1f MB" % (os.path.getsize(INSTALLER) / 1048576))

    # 1) 建仓
    st, d = g.call("GET", f"/repos/{FULL}")
    if st == 404:
        print("仓库不存在，尝试创建…")
        st, d = g.call("POST", "/user/repos", {
            "name": REPO, "description": DESC, "private": False,
            "has_issues": True, "has_wiki": False, "auto_init": False,
        })
        if st not in (200, 201):
            print("FAIL create", st, json.dumps(d, ensure_ascii=False)[:300])
            print("→ token 缺 Administration: Read and write（或该权限未保存生效）")
            return 1
        print("created:", d["html_url"])
    elif st == 200:
        print("仓库已存在:", d["html_url"])
    else:
        print("FAIL query repo", st, json.dumps(d, ensure_ascii=False)[:300])
        return 1

    # 2) push（token 拼在 URL 里，不写进 .git/config）
    remote = "https://x-access-token:%s@github.com/%s.git" % (g.token(), FULL)
    clean = "https://github.com/%s.git" % FULL
    sh(["git", "remote", "remove", "origin"])
    if sh(["git", "remote", "add", "origin", clean]) != 0:
        return 1
    # 本机对 github.com 做了 TLS 中间人，schannel 报 SEC_E_UNTRUSTED_ROOT，必须关校验
    if sh(["git", "-c", "credential.helper=", "-c", "http.sslVerify=false",
           "push", remote, "main:main"]) != 0:
        print("FAIL push → token 缺 Contents: Read and write")
        return 1
    sh(["git", "branch", "--set-upstream-to=origin/main", "main"])

    # 3) Release + 资产
    body = open(NOTES, encoding="utf-8").read()
    st, d = g.call("GET", f"/repos/{FULL}/releases/tags/{TAG}")
    if st == 404:
        st, d = g.call("POST", f"/repos/{FULL}/releases", {
            "tag_name": TAG, "name": TITLE, "body": body,
            "draft": False, "prerelease": False,
        })
        if st not in (200, 201):
            print("FAIL create release", st, json.dumps(d, ensure_ascii=False)[:300])
            return 1
    elif st != 200:
        print("FAIL query release", st, json.dumps(d, ensure_ascii=False)[:300])
        return 1
    print("release:", d["html_url"])

    up = d["upload_url"].split("{")[0]
    data = open(INSTALLER, "rb").read()
    import urllib.parse
    import time
    name = os.path.basename(INSTALLER)
    print("uploading %s (%.1f MB) …" % (name, len(data) / 1048576))
    t0 = time.time()
    st, d2 = g.call("POST", f"{up}?name={urllib.parse.quote(name)}", data,
                    ctype="application/octet-stream")
    if st not in (200, 201):
        print("FAIL upload", st, json.dumps(d2, ensure_ascii=False)[:300])
        return 1
    print("  ok %.1f MB in %.0fs" % (d2["size"] / 1048576, time.time() - t0))
    print("  ->", d2["browser_download_url"])
    print("\nDONE:", d["html_url"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
