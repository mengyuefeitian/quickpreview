"""把 docs/releases/<tag>.md 同步为线上 Release 正文。

只 PATCH body，不动 tag、不动资产、不改发布状态。
用法：python dev_sync_release_body.py [--dry]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dev_gh as g

OWNER = "mengyuefeitian"
REPO = "quickpreview"
FULL = "%s/%s" % (OWNER, REPO)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES_DIR = os.path.join(ROOT, "docs", "releases")

DRY = "--dry" in sys.argv


def main():
    st, rels = g.call("GET", "/repos/%s/releases?per_page=100" % FULL)
    if st != 200:
        print("读取 Release 失败:", st)
        return 1

    by_tag = {r["tag_name"]: r for r in rels}
    tags = sorted(by_tag)
    print("线上 Release: %d 个" % len(tags))

    ok = 0
    for tag in tags:
        path = os.path.join(NOTES_DIR, "%s.md" % tag)
        if not os.path.isfile(path):
            print("  %-7s 跳过：本地缺少 %s" % (tag, os.path.basename(path)))
            continue
        with open(path, encoding="utf-8") as f:
            body = f.read().strip()

        if DRY:
            print("  %-7s [dry] %d 字" % (tag, len(body)))
            ok += 1
            continue

        st2, d = g.call("PATCH", "/repos/%s/releases/%d" % (FULL, by_tag[tag]["id"]),
                        {"body": body})
        if st2 == 200:
            same = (d.get("body") or "").strip() == body
            print("  %-7s 更新成功（%d 字，回读一致=%s）" % (tag, len(body), same))
            ok += 1
        else:
            print("  %-7s 失败: %s %s" % (tag, st2, str(d)[:120]))

    print("完成 %d/%d" % (ok, len(tags)))
    return 0 if ok == len(tags) else 1


if __name__ == "__main__":
    sys.exit(main())
