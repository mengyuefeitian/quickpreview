# -*- coding: utf-8 -*-
"""Range 解析 / 分块纯函数断言（FileRange.Resolve）。

为什么要有这个用例：
    __local 的区间计算跑在 WebView2 的资源拦截回调里，算错一个字节的表现是
    「视频放不了 / 拖不动进度条」，而且这时浏览器往往已经崩了，日志里什么都看不到。
    把 FileRange.Resolve 抽成纯函数之后，这里用离线命令行逐条断言边界，
    不依赖浏览器、不依赖 GPU、不依赖播放器。

用法：
    python test-samples/dev_range_test.py
退出码 0 = 全部通过。
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DOTNET = os.path.join(os.path.dirname(REPO), ".dotnet-sdk", "dotnet.exe")
SRC = os.path.join(REPO, "dotnet", "QuickPreview", "FileRange.cs")

CSPROJ = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <AssemblyName>rangetest</AssemblyName>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.cs" />
    <Compile Include="%s" />
  </ItemGroup>
</Project>
""" % SRC

PROGRAM = r'''using System;
using QuickPreview;

static class T
{
    const long MB = 1024 * 1024;
    const long CHUNK = 8 * MB;
    const long BIG = 1975618907L;      // 用户日志里那个 1.9GB 的 mp4

    static int fail, pass;

    static void Case(string name, string range, long total, long chunk,
                     long start, long end, int status, long len, bool capped,
                     string contentRange)
    {
        var r = FileRange.Resolve(range, total, chunk);
        var bad = new System.Collections.Generic.List<string>();
        if (r.Start != start) bad.Add("Start " + r.Start + " != " + start);
        if (r.End != end) bad.Add("End " + r.End + " != " + end);
        if (r.Status != status) bad.Add("Status " + r.Status + " != " + status);
        if (r.Length != len) bad.Add("Length " + r.Length + " != " + len);
        if (r.Capped != capped) bad.Add("Capped " + r.Capped + " != " + capped);
        if ((r.ContentRange ?? "(null)") != (contentRange ?? "(null)"))
            bad.Add("ContentRange " + (r.ContentRange ?? "(null)") + " != " + (contentRange ?? "(null)"));

        if (bad.Count == 0) { pass++; Console.WriteLine("  PASS  " + name); }
        else
        {
            fail++;
            Console.WriteLine("  FAIL  " + name);
            foreach (var b in bad) Console.WriteLine("          " + b);
        }
    }

    static int Main()
    {
        // ---------- 核心：GB 级视频的首包必须被截断 ----------
        // Chromium 发的就是 `bytes=0-`。以前照字面回 1,975,618,907 字节，
        // WebView2 吃不下 → 浏览器进程崩 → 宿主一起死（issue #5）。
        Case("1.9GB 首包 bytes=0- 被截到 8MB", "bytes=0-", BIG, CHUNK,
             0, CHUNK - 1, 206, CHUNK, true,
             "bytes 0-" + (CHUNK - 1) + "/" + BIG);

        Case("1.9GB 续包 bytes=8388608- 继续 8MB", "bytes=8388608-", BIG, CHUNK,
             CHUNK, CHUNK * 2 - 1, 206, CHUNK, true,
             "bytes " + CHUNK + "-" + (CHUNK * 2 - 1) + "/" + BIG);

        // 尾部剩下的不足一块 → 不截断，还要对上 total
        Case("末段不足 8MB 不截断", "bytes=" + (BIG - 1000) + "-", BIG, CHUNK,
             BIG - 1000, BIG - 1, 206, 1000, false,
             "bytes " + (BIG - 1000) + "-" + (BIG - 1) + "/" + BIG);

        Case("正好 8MB 不截断", "bytes=0-", CHUNK, CHUNK,
             0, CHUNK - 1, 206, CHUNK, false, "bytes 0-" + (CHUNK - 1) + "/" + CHUNK);

        // ---------- 普通分片（text.ts 自己按块读，一块 256KB）----------
        Case("text.ts 的 256KB 闭区间", "bytes=0-262143", 12345678, CHUNK,
             0, 262143, 206, 262144, false, "bytes 0-262143/12345678");

        // ---------- 200 全量（页面 fetch 整份 docx/zip/pdf），绝不能截 ----------
        Case("无 Range 的 200 全量不截断", null, 14 * MB, CHUNK,
             0, 14 * MB - 1, 200, 14 * MB, false, null);

        Case("空文件 200", null, 0, CHUNK, 0, -1, 200, 0, false, null);

        // ---------- 其它边界 ----------
        Case("suffix bytes=-65536", "bytes=-65536", 1000000, CHUNK,
             1000000 - 65536, 999999, 206, 65536, false, "bytes 934464-999999/1000000");

        Case("suffix 超过文件大小", "bytes=-999999", 100, CHUNK,
             0, 99, 206, 100, false, "bytes 0-99/100");

        Case("start 越界收敛到末字节", "bytes=500-", 200, CHUNK,
             199, 199, 206, 1, false, "bytes 199-199/200");

        Case("end 越界收敛到 total-1", "bytes=0-99999", 1000, CHUNK,
             0, 999, 206, 1000, false, "bytes 0-999/1000");

        Case("end<start 收敛", "bytes=50-10", 1000, CHUNK,
             50, 50, 206, 1, false, "bytes 50-50/1000");

        Case("多区间只取第一段", "bytes=0-99,200-299", BIG, CHUNK,
             0, 99, 206, 100, false, "bytes 0-99/" + BIG);

        Case("非法范围值退化为整个文件(再被截断)", "bytes=abc-", BIG, CHUNK,
             0, CHUNK - 1, 206, CHUNK, true, "bytes 0-" + (CHUNK - 1) + "/" + BIG);

        Case("空文件带 Range", "bytes=0-", 0, CHUNK,
             0, 0, 206, 1, false, "bytes 0-0/0");

        Case("maxChunk=0 表示不限", "bytes=0-", BIG, 0,
             0, BIG - 1, 206, BIG, false, "bytes 0-" + (BIG - 1) + "/" + BIG);

        Case("非 bytes= 前缀的 Range 当没有", "items=0-", 100, CHUNK,
             0, 99, 200, 100, false, null);

        Console.WriteLine();
        Console.WriteLine("通过 " + pass + " 项，失败 " + fail + " 项");
        return fail == 0 ? 0 : 1;
    }
}
'''


def main():
    if not os.path.exists(SRC):
        print("找不到源文件：" + SRC)
        return 2
    tmp = tempfile.mkdtemp(prefix="qprange")
    try:
        with open(os.path.join(tmp, "t.csproj"), "w", encoding="utf-8") as f:
            f.write(CSPROJ)
        with open(os.path.join(tmp, "Program.cs"), "w", encoding="utf-8") as f:
            f.write(PROGRAM)

        env = dict(os.environ)
        sdk = os.path.dirname(DOTNET)
        env["DOTNET_ROOT"] = sdk
        env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
        env["DOTNET_NOLOGO"] = "1"

        print("=== FileRange.Resolve 断言 ===")
        r = subprocess.run([DOTNET, "run", "-c", "Release", "--project", tmp],
                           cwd=tmp, env=env, capture_output=True, shell=False)
        out = r.stdout.decode("utf-8", "replace")
        err = r.stderr.decode("utf-8", "replace")
        print(out.rstrip())
        if r.returncode != 0:
            if err.strip():
                print("--- stderr ---")
                print(err.rstrip()[-3000:])
            return 1
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
