# -*- coding: utf-8 -*-
"""把恢复回来的旧仓库里的 issue 搬到正式仓库。

背景：清理敏感对象时误删过仓库，用户在该仓库里有 4 条 bug issue。
GitHub 无法单独恢复 issue，只能在 90 天内恢复整个仓库：
  头像 → Settings → Repositories → Deleted repositories → Restore

恢复后的旧库叫 mengyuefeitian/quick-preview（历史里仍有敏感对象），
正式仓库是 mengyuefeitian/quickpreview（历史已清洗、14 个 Release 齐全）。

本脚本只搬 issue，不动任何一个仓库的 git 内容：
  check  → 看旧库是否已恢复、有几条 issue
  apply  → 备份 issue 到 .testdata/issues_backup.json → 逐条 transfer 到正式仓库

注意：transfer 后 issue 编号会变成正式仓库的下一个可用编号，正文/评论/标签保留。
若 transfer 不可用（权限或 GraphQL 变更），会退化为「按备份重建」。
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dev_gh as g

RESTORED = "mengyuefeitian/quick-preview"   # 恢复回来的旧库（issue 在这里）
TARGET = "mengyuefeitian/quickpreview"      # 正式仓库
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.join(os.path.dirname(ROOT), ".testdata", "issues_backup.json")
API = "https://api.github.com"


def graphql(query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        API + "/graphql", data=body,
        headers={"Authorization": "bearer " + g.token(),
                 "Content-Type": "application/json",
                 "User-Agent": "quickpreview-dev"})
    ctx = g.SSL_CTX
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"errors": [{"message": e.read().decode()[:300]}]}


def list_issues(repo=RESTORED):
    st, xs = g.call("GET", "/repos/%s/issues?state=all&per_page=100" % repo)
    if st != 200 or not isinstance(xs, list):
        return None
    return [x for x in xs if "pull_request" not in x]


def check():
    st, d = g.call("GET", "/repos/%s" % RESTORED)
    if st != 200:
        print("旧库 %s 不存在（%s）——还没恢复。" % (RESTORED, st))
        return False
    if isinstance(d, dict) and d.get("full_name") != RESTORED:
        print("旧库名仍被重定向到 %s ——还没恢复。" % d.get("full_name"))
        return False
    print("✅ 旧库已恢复：%s（创建于 %s）" % (d.get("full_name"), d.get("created_at")))

    issues = list_issues()
    print("issue 数量：%s" % (len(issues) if issues is not None else "读取失败"))
    if issues:
        for i in issues:
            print("  #%s [%s] %s" % (i["number"], i["state"], i["title"]))
    st2, t = g.call("GET", "/repos/%s" % TARGET)
    print("正式仓库 %s -> %s" % (TARGET, st2))
    st3, ti = g.call("GET", "/repos/%s/issues?state=all&per_page=100" % TARGET)
    print("正式仓库现有 issue：%s" % (len([x for x in ti if "pull_request" not in x]) if isinstance(ti, list) else st3))
    return True


def backup():
    issues = list_issues()
    if not issues:
        print("没有可备份的 issue。")
        return []
    out = []
    for i in issues:
        st, cs = g.call("GET", "/repos/%s/issues/%d/comments?per_page=100" % (RESTORED, i["number"]))
        out.append({
            "number": i["number"],
            "title": i["title"],
            "body": i.get("body") or "",
            "state": i["state"],
            "labels": [l["name"] for l in i.get("labels", [])],
            "created_at": i["created_at"],
            "comments": [{"user": c["user"]["login"], "body": c.get("body") or "",
                          "created_at": c["created_at"]} for c in (cs if isinstance(cs, list) else [])],
        })
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("已备份 %d 条 -> %s" % (len(out), BACKUP))
    return out


def transfer():
    st, t = g.call("GET", "/repos/%s" % TARGET)
    if st != 200:
        print("取正式仓库失败:", st)
        return 0
    target_id = t["node_id"]
    issues = list_issues() or []
    ok = 0
    for i in issues:
        q = """mutation($issue:ID!,$repo:ID!){
          transferIssue(input:{issueId:$issue,repositoryId:$repo}){
            issue{ number url }
          }
        }"""
        r = graphql(q, {"issue": i["node_id"], "repo": target_id})
        if "errors" in r:
            print("  #%s 转移失败：%s" % (i["number"], json.dumps(r["errors"], ensure_ascii=False)[:200]))
            continue
        node = r.get("data", {}).get("transferIssue", {}).get("issue", {})
        print("  #%s → %s 编号 %s" % (i["number"], TARGET, node.get("number")))
        ok += 1
    return ok


def rebuild(data):
    """transfer 不可用时按备份重建（编号会从 1 开始，评论按顺序补发）。"""
    odd = 0
    for d in data:
        st, r = g.call("POST", "/repos/%s/issues" % TARGET,
                       {"title": d["title"], "body": d["body"], "labels": d["labels"]})
        if st not in (200, 201):
            print("  重建失败 #%s -> %s" % (d["number"], st))
            continue
        for c in d.get("comments", []):
            g.call("POST", "/repos/%s/issues/%d/comments" % (TARGET, r["number"]),
                   {"body": "**%s**（原评论，%s）：\n\n%s" % (c["user"], c["created_at"], c["body"])})
        if d["state"] == "closed":
            g.call("PATCH", "/repos/%s/issues/%d" % (TARGET, r["number"]), {"state": "closed"})
        print("  #%s → #%s %s" % (d["number"], r["number"], d["title"][:40]))
        odd += 1
    return odd


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    if mode == "check":
        check()
    elif mode == "apply":
        if not check():
            print("\n旧库还没恢复，先别跑 apply。")
            sys.exit(1)
        print("\n--- 1. 备份 issue ---")
        data = backup()
        print("\n--- 2. 转移 issue 到正式仓库 ---")
        n = transfer()
        if n < len(data):
            print("转移未全部成功，按备份补齐剩余 %d 条：" % (len(data) - n))
            rebuild(data[n:])
        print("\n--- 3. 结果 ---")
        st, ti = g.call("GET", "/repos/%s/issues?state=all&per_page=100" % TARGET)
        got = [x for x in ti if "pull_request" not in x] if isinstance(ti, list) else []
        print("正式仓库 issue 数量：%d" % len(got))
        for i in got:
            print("  #%s [%s] %s" % (i["number"], i["state"], i["title"]))
    else:
        print(__doc__)
