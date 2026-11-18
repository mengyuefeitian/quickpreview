# -*- coding: utf-8 -*-
"""打包前的硬闸。任何一条不过就不许出包。

拦住的三类事：
1. 三处版本号不一致（csproj / setup.iss / package.json）；
2. CHANGELOG 没有对应版本节、_titles.json 没有对应 tag；
3. **同号重打** —— installer 里已经存在这个版本的安装包。
   一个号只能打一次包，改了代码就升号，不许用新包顶掉旧包。
   确实要重打（例如安装验证失败）必须显式 `--force`，并在日志里留痕。

用法：
    python test-samples/check_version_preflight.py            # 出包前自动跑
    python test-samples/check_version_preflight.py --force    # 明知故犯，需人肉决定
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSPROJ = os.path.join(ROOT, "dotnet", "QuickPreview", "QuickPreview.csproj")
ISS = os.path.join(ROOT, "dotnet", "setup.iss")
PKG = os.path.join(ROOT, "package.json")
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
TITLES = os.path.join(ROOT, "docs", "releases", "_titles.json")
INSTALLER = os.path.join(ROOT, "installer")


def read(p):
    return io.open(p, encoding="utf-8").read()


def main(argv):
    force = "--force" in argv
    fails = []

    text = read(CSPROJ)
    v_csproj = re.search(r"<Version>([\d.]+)</Version>", text).group(1)
    v_asm = re.search(r"<AssemblyVersion>([\d.]+)</AssemblyVersion>", text).group(1)
    v_file = re.search(r"<FileVersion>([\d.]+)</FileVersion>", text).group(1)
    v_iss = re.search(r'#define\s+MyAppVersion\s+"([\d.]+)"', read(ISS)).group(1)
    v_pkg = json.loads(read(PKG))["version"]

    print("版本：csproj=%s  asm=%s  file=%s  iss=%s  pkg=%s" % (v_csproj, v_asm, v_file, v_iss, v_pkg))

    if len({v_csproj, v_iss, v_pkg}) != 1:
        fails.append("三处版本号不一致（csproj=%s / iss=%s / package.json=%s）" % (v_csproj, v_iss, v_pkg))
    if v_asm.split(".")[:3] != v_csproj.split(".")[:3] or v_file.split(".")[:3] != v_csproj.split(".")[:3]:
        fails.append("AssemblyVersion/FileVersion 与 Version 不同步（%s / %s）" % (v_asm, v_file))

    if "## [%s]" % v_csproj not in read(CHANGELOG):
        fails.append("CHANGELOG 缺少 [%s] 节" % v_csproj)

    if os.path.exists(TITLES):
        if "v%s" % v_csproj not in json.loads(read(TITLES)):
            fails.append("docs/releases/_titles.json 缺少 v%s 标题" % v_csproj)
        if not os.path.exists(os.path.join(ROOT, "docs", "releases", "v%s.md" % v_csproj)):
            fails.append("缺少 docs/releases/v%s.md 发布正文" % v_csproj)

    target = os.path.join(INSTALLER, "QuickPreview-Setup-%s-x64.exe" % v_csproj)
    if os.path.exists(target):
        msg = "installer 里已经存在 %s —— 同号重打！改完代码应该升版本号，不是覆盖旧包" % os.path.basename(target)
        if force:
            print("[WARN] " + msg + "（--force 已放行，以此留痕）")
        else:
            fails.append(msg + "。确认要重打请加 --force")

    if fails:
        print("\n[BLOCKED] 不许出包：")
        for f in fails:
            print("  - " + f)
        return 1

    print("[PASS] 版本 %s 可以打包" % v_csproj)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
