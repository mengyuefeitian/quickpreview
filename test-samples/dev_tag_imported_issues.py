# -*- coding: utf-8 -*-
"""给已重建的 issue 补上「迁移自旧仓库 #N」标记。

私有库的 issue 无法 transfer 到公开库（GitHub 禁止 private → public），
只能按备份重建。重建后编号会重排、原始反馈时间丢失，这里补一行引用说明来源。

前提：token 必须带 **Issues: Read and write**。只有 read 时 REST `PATCH /issues/{n}`
与 GraphQL `updateIssue` 都会返回 `403 Resource not accessible by personal access token`
（能 POST 新建、不能 PATCH 修改）。权限不足时本脚本会整批失败，属于预期。
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dev_gh as g

TARGET = "mengyuefeitian/quickpreview"
BACKUP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "..", ".testdata", "issues_backup.json")
CST = timezone(timedelta(hours=8))
MARK = "> 迁移自旧仓库 issue #{n}（原反馈时间 {t}）\n\n"


def cst(iso):
    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc).astimezone(CST).strftime("%Y-%m-%d %H:%M")


def main():
    backup = json.load(open(os.path.normpath(BACKUP), encoding="utf-8"))
    origin = {x["title"]: x for x in backup}

    st, issues = g.call("GET", "/repos/%s/issues?state=all&per_page=100" % TARGET)
    if st != 200 or not isinstance(issues, list):
        print("读取新库 issue 失败:", st)
        return 1

    for i in issues:
        if "pull_request" in i:
            continue
        src = origin.get(i["title"])
        if not src:
            print("  #%d 找不到对应备份，跳过" % i["number"])
            continue
        head = MARK.format(n=src["number"], t=cst(src["created_at"]))
        body = i.get("body") or ""
        if body.startswith("> 迁移自旧仓库"):
            print("  #%d 已有标记，跳过" % i["number"])
            continue
        st2, d = g.call("PATCH", "/repos/%s/issues/%d" % (TARGET, i["number"]),
                        {"body": head + body})
        print("  #%d ← 旧 #%d（%s）%s" % (i["number"], src["number"], cst(src["created_at"]),
                                        "OK" if st2 == 200 else "失败 %s" % st2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
