# -*- coding: utf-8 -*-
"""校验 src/shared/mime.ts 与 dotnet/QuickPreview/FileTypes.cs 的扩展名列表是否一致。

两边各维护一份「可预览扩展名」，一旦漂移就会出现：
前端认识该类型、宿主却判定不支持 —— 用户按空格没反应（.ps1 / .bat 曾经就是这样）。

用法：python check_ext_parity.py
退出码 0 = 一致；1 = 有差异（会列出只在某一侧出现的扩展名）。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS = os.path.join(ROOT, "src", "shared", "mime.ts")
CS = os.path.join(ROOT, "dotnet", "QuickPreview", "FileTypes.cs")

TS_GROUPS = ["IMAGE_EXT", "TEXT_EXT", "PDF_EXT", "OFFICE_EXT",
             "AUDIO_EXT", "VIDEO_EXT", "ARCHIVE_EXT", "WEBARCHIVE_EXT"]


def parse_ts(path):
    src = open(path, encoding="utf-8").read()
    # 先剥掉行注释：注释里出现的 '.xxx' 字样会被下面的正则误当成扩展名
    src = re.sub(r"//[^\n]*", "", src)
    out = set()
    for g in TS_GROUPS:
        m = re.search(r"const\s+%s\s*=\s*\[(.*?)\];" % g, src, re.S)
        if not m:
            print("  !! 未找到 %s" % g)
            continue
        out |= set(re.findall(r"'([^']+)'", m.group(1)))
    names = re.search(r"const\s+TEXT_FILENAMES\s*=\s*\[(.*?)\];", src, re.S)
    file_names = set(re.findall(r"'([^']+)'", names.group(1))) if names else set()
    return out, file_names


def parse_cs(path):
    src = open(path, encoding="utf-8").read()
    out = set()
    for g in ["TextExt", "BinaryExt", "WebArchiveExt"]:
        m = re.search(g + r"\s*=\s*new HashSet<string>\([^)]*\)\s*\{(.*?)\};", src, re.S)
        if not m:
            print("  !! 未找到 %s" % g)
            continue
        out |= {x.lstrip(".").lower() for x in re.findall(r'"(\.[^"]+)"', m.group(1))}
    names = re.search(r"TextNames\s*=\s*new HashSet<string>\([^)]*\)\s*\{(.*?)\};", src, re.S)
    file_names = {x.lower() for x in re.findall(r'"([^"]+)"', names.group(1))} if names else set()
    return out, file_names


def main():
    ts_ext, ts_names = parse_ts(TS)
    cs_ext, cs_names = parse_cs(CS)

    print("mime.ts   扩展名 %d 个 | 特殊文件名 %d 个" % (len(ts_ext), len(ts_names)))
    print("FileTypes 扩展名 %d 个 | 特殊文件名 %d 个" % (len(cs_ext), len(cs_names)))

    only_ts = sorted(ts_ext - cs_ext)
    only_cs = sorted(cs_ext - ts_ext)
    n_ts = sorted(ts_names - cs_names)
    n_cs = sorted(cs_names - ts_names)

    ok = True
    if only_ts:
        ok = False
        print("\n❌ 只在 mime.ts 里有（宿主会判定不支持）：")
        print("   " + " ".join("." + x for x in only_ts))
    if only_cs:
        ok = False
        print("\n❌ 只在 FileTypes.cs 里有（前端会当作不支持）：")
        print("   " + " ".join("." + x for x in only_cs))
    if n_ts:
        ok = False
        print("\n❌ 特殊文件名只在 mime.ts 里：" + " ".join(n_ts))
    if n_cs:
        ok = False
        print("\n❌ 特殊文件名只在 FileTypes.cs 里：" + " ".join(n_cs))

    if ok:
        print("\n✅ 两侧完全一致（%d 个扩展名 + %d 个特殊文件名）" % (len(ts_ext), len(ts_names)))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
