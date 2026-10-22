# -*- coding: utf-8 -*-
"""Check every release note against docs/releases/_TEMPLATE.md.

    python test-samples/check_release_notes.py            # all published versions
    python test-samples/check_release_notes.py v1.6.6     # one version

Exit code 0 = all good. Only tags listed in _titles.json are checked
(unpublished drafts such as v1.6.5 are skipped).
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REL_DIR = os.path.join(ROOT, "docs", "releases")

SOFT_LIMIT = 1200
TITLE_RE = re.compile(r"^v\d+\.\d+\.\d+ — \S.{5,23}$")
TABLE_RE = re.compile(r"^\s*\|?[\s\-:|]{6,}\|\s*$", re.M)

FORBIDDEN = [
    ("_发布日期", "drop the release date (the page shows it)"),
    ("### 验证", "drop the 验证 section (internal test results)"),
    ("## v", "drop the version heading (the page title already has it)"),
]


def check(tag, name, body):
    errs = []
    if not TITLE_RE.match(name):
        errs.append("title format: want 'vX.Y.Z — <8~22 chars subject>', got %r" % name)
    if "QuickPreview" in name:
        errs.append("title should not contain the product name")

    n = len(body)
    if n > SOFT_LIMIT:
        errs.append("body is %d chars (> %d)" % (n, SOFT_LIMIT))

    for token, hint in FORBIDDEN:
        if token in body:
            errs.append("%s -> %s" % (token.strip(), hint))

    if TABLE_RE.search(body):
        errs.append("markdown table found (move comparison data to CHANGELOG)")

    if "### 安装" not in body:
        errs.append("missing '### 安装' section")
    if "CHANGELOG" not in body:
        errs.append("missing CHANGELOG link")

    first = (body.strip().splitlines() or [""])[0]
    if first.startswith("#"):
        errs.append("body must start with a one-line summary, not a heading")

    return errs


def main():
    want = sys.argv[1] if len(sys.argv) > 1 else None
    titles_path = os.path.join(REL_DIR, "_titles.json")
    if not os.path.exists(titles_path):
        print("missing " + titles_path)
        return 2
    titles = json.load(io.open(titles_path, encoding="utf-8"))

    tags = sorted(titles, key=lambda t: [int(x) for x in t[1:].split(".")])
    if want:
        if want not in titles:
            print("unknown tag: " + want)
            return 2
        tags = [want]

    failed = 0
    for tag in tags:
        p = os.path.join(REL_DIR, tag + ".md")
        if not os.path.exists(p):
            print("[FAIL] %-7s missing file %s" % (tag, p))
            failed += 1
            continue
        body = io.open(p, encoding="utf-8").read()
        errs = check(tag, titles[tag], body)
        if errs:
            failed += 1
            print("[FAIL] %-7s %d chars" % (tag, len(body)))
            for e in errs:
                print("       - " + e)
        else:
            print("[PASS] %-7s %3d chars  %s" % (tag, len(body), titles[tag]))

    print("")
    print("%d/%d ok" % (len(tags) - failed, len(tags)))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
