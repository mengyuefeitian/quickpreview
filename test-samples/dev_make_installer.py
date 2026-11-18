# -*- coding: utf-8 -*-
"""用解包出来的 Inno Setup 6.2.2 命令行编译器打安装包。

6.2.2 按系统 ANSI(GBK) 读 .iss 和 .isl，所以两个文件都要转成 GBK 无 BOM 的临时副本；
原始文件保持 UTF-8 不动（官方 6.7.4 默认就是 UTF-8）。详见 .workbuddy/memory/MEMORY.md。
"""
import io
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ISS = os.path.join(ROOT, "dotnet", "setup.iss")
ISL = os.path.join(ROOT, "dotnet", "ChineseSimplified.isl")
ISCC = os.path.join(tempfile.gettempdir(), "isx2", "app", "ISCC.exe")

TMP_ISS = os.path.join(ROOT, "dotnet", "setup.tmpbuild.iss")
TMP_ISL = os.path.join(ROOT, "dotnet", "ChineseSimplified.tmpbuild.isl")


def to_gbk(text, name):
    for ch in set(text):
        try:
            ch.encode("gbk")
        except UnicodeEncodeError:
            raise SystemExit("%s 里有 GBK 无法表示的字符 %r" % (name, ch))
    return text.encode("gbk")


def main():
    # 出包前先过硬闸：三处版本号一致、CHANGELOG/_titles/正文齐全、installer 里没有同号旧包。
    # 任一条不过就拒绝打包（重打需显式 --force）。
    gate = os.path.join(ROOT, "test-samples", "check_version_preflight.py")
    r = subprocess.run([sys.executable, gate] + sys.argv[1:])
    if r.returncode != 0:
        return r.returncode

    if not os.path.exists(ISCC):
        raise SystemExit("找不到 ISCC：" + ISCC)

    iss = io.open(ISS, encoding="utf-8").read()
    # 6.2 不认识 x64compatible（6.3+ 才有）
    iss = iss.replace("x64compatible", "x64")
    iss = iss.replace('"ChineseSimplified.isl"', '"ChineseSimplified.tmpbuild.isl"')
    io.open(TMP_ISS, "wb").write(to_gbk(iss, "setup.iss"))

    isl = io.open(ISL, encoding="utf-8").read()
    io.open(TMP_ISL, "wb").write(to_gbk(isl, "ChineseSimplified.isl"))

    try:
        r = subprocess.run([ISCC, TMP_ISS], cwd=ROOT)
        print("ISCC exit=%d" % r.returncode)
        return r.returncode
    finally:
        for p in (TMP_ISS, TMP_ISL):
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
