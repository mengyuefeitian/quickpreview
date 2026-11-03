# -*- coding: utf-8 -*-
"""自动更新：纯逻辑离线断言（版本比较 / Release JSON 解析 / 资产挑选 / 下载地址白名单）。

为什么要有这个用例：
    自动更新一旦判断错，用户看到的是"永远提示有新版本"或者"点了更新没反应"；
    更糟的是挑错资产、跑错 exe —— 那是把一个第三方文件执行起来。
    这些判断全是纯函数，可以完全离线逐条断言，不需要装新版本、不需要真的联网。

做法（与 dev_range_test.py 同一套路）：
    临时建一个 net8.0 控制台工程，编译 UpdateService.cs + Logger.cs，
    AppConfig / AppVersion 用最小桩替代（只为提供 Dir 与 Current），然后在里面跑断言。

用法：
    python test-samples/dev_update_test.py
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
SRC_DIR = os.path.join(REPO, "dotnet", "QuickPreview")

CSPROJ = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <AssemblyName>updatetest</AssemblyName>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.cs" />
    <Compile Include="Stubs.cs" />
    <Compile Include="UpdateService.cs" />
    <Compile Include="Logger.cs" />
  </ItemGroup>
</Project>
"""

# 桩：只提供 UpdateService 用到的那两个成员，避免把 WinForms 依赖拖进来
STUBS = r'''using System;
using System.IO;

namespace QuickPreview
{
    public static class AppConfig
    {
        public static readonly string Dir = Path.Combine(Path.GetTempPath(), "qp_update_test");
    }

    public static class AppVersion
    {
        public static string Current = "1.8.0";
    }
}
'''

PROGRAM = r'''using System;
using System.Collections.Generic;
using QuickPreview;

static class T
{
    static int fail, pass;

    static void Check(string name, bool ok, string detail)
    {
        if (ok) { pass++; Console.WriteLine("  PASS  " + name); }
        else { fail++; Console.WriteLine("  FAIL  " + name); if (detail != null) Console.WriteLine("          " + detail); }
    }

    static void Cmp(string name, string a, string b, int want)
    {
        int got = UpdateService.CompareVersion(a, b);
        int norm = got == 0 ? 0 : (got < 0 ? -1 : 1);
        Check(name, norm == want, "CompareVersion(\"" + a + "\",\"" + b + "\") = " + got + "，期望符号 " + want);
    }

    static void Norm(string name, string raw, string want)
    {
        var got = UpdateService.NormalizeVersion(raw);
        Check(name, got == want, "NormalizeVersion(\"" + raw + "\") = \"" + got + "\"，期望 \"" + want + "\"");
    }

    const string FullRelease = @"{
      ""tag_name"": ""v1.9.0"",
      ""name"": ""v1.9.0 — 自动更新"",
      ""body"": ""### 新增\n- 自动更新"",
      ""html_url"": ""https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.9.0"",
      ""draft"": false,
      ""prerelease"": false,
      ""published_at"": ""2026-11-03T10:00:00Z"",
      ""assets"": [
        { ""name"": ""source.zip"", ""size"": 12, ""browser_download_url"": ""https://github.com/o/r/releases/download/v1.9.0/source.zip"" },
        { ""name"": ""QuickPreview-Setup-1.9.0-x64.exe"", ""size"": 72134915,
          ""digest"": ""sha256:A9FC105756CFF5A364F9742CE4883FC1CB1541B67EDACDA870D18EDA68AEB3F3"",
          ""browser_download_url"": ""https://github.com/o/r/releases/download/v1.9.0/QuickPreview-Setup-1.9.0-x64.exe"" }
      ]
    }";

    static int Main()
    {
        Console.WriteLine("[版本号规范化]");
        Norm("v 前缀去掉", "v1.9.0", "1.9.0");
        Norm("预发布尾巴去掉", "1.9.0-beta.1", "1.9.0");
        Norm("加号构建号去掉", "1.9.0+build.7", "1.9.0");
        Norm("空串", "", "");
        Norm("两位", "v2.0", "2.0");

        Console.WriteLine("[版本号比较：必须按数值逐段，不能按字符串]");
        // 字符串比较会认为 "1.10.0" < "1.9.0"，这正是最容易写错、且后果最严重的地方
        Cmp("1.10.0 > 1.9.0", "1.10.0", "1.9.0", 1);
        Cmp("1.2.10 > 1.2.9", "1.2.10", "1.2.9", 1);
        Cmp("相同版本相等", "1.8.0", "1.8.0", 0);
        Cmp("v 前缀不影响比较", "v1.8.0", "1.8.0", 0);
        Cmp("补零等价", "1.9", "1.9.0", 0);
        Cmp("修订号变大", "1.9.1", "1.9.0", 1);
        Cmp("次版本号更大", "2.0.0", "1.99.99", 1);
        Cmp("旧版本小于当前", "1.7.9", "1.8.0", -1);
        Cmp("空版本视为最小", "", "1.0.0", -1);
        Cmp("超长数字段不溢出", "1.999999999999.0", "1.5.0", 1);

        Console.WriteLine("[Release JSON 解析]");
        string err;
        var info = UpdateService.ParseRelease(FullRelease, out err);
        Check("能解析出信息", info != null, err);
        if (info != null)
        {
            Check("版本号", info.Version == "1.9.0", info.Version);
            Check("tag 原样保留", info.TagName == "v1.9.0", info.TagName);
            Check("标题", info.Name == "v1.9.0 — 自动更新", info.Name);
            Check("发布时间按 UTC 解析", info.PublishedAtUtc.ToString("yyyy-MM-dd") == "2026-11-03",
                  info.PublishedAtUtc.ToString("o"));

            // 资产挑选：必须在 zip 与 exe 之间选 exe，且优先带 Setup 的那个
            Check("挑中安装包", info.AssetName == "QuickPreview-Setup-1.9.0-x64.exe", info.AssetName);
            Check("大小", info.AssetSize == 72134915, info.AssetSize.ToString());
            Check("digest 转小写十六进制", info.AssetSha256 == "a9fc105756cff5a364f9742ce4883fc1cb1541b67edacda870d18eda68aeb3f3",
                  info.AssetSha256);
            Check("地址", info.AssetUrl.Contains("/releases/download/"), info.AssetUrl);
        }

        Console.WriteLine("[异常输入必须给出可读原因，而不是抛异常]");
        var draft = FullRelease.Replace(@"""draft"": false", @"""draft"": true");
        Check("草稿版本不出更新", UpdateService.ParseRelease(draft, out err) == null, err);
        Check("草稿原因可读", err.Contains("草稿"), err);

        var pre = FullRelease.Replace(@"""prerelease"": false", @"""prerelease"": true");
        Check("预发布版本不出更新", UpdateService.ParseRelease(pre, out err) == null, err);

        var noTag = @"{ ""name"": ""x"", ""assets"": [] }";
        Check("缺 tag_name 不崩", UpdateService.ParseRelease(noTag, out err) == null, err);
        Check("缺 tag 原因可读", err.Contains("版本号"), err);

        var badJson = "{ not json";
        Check("坏 JSON 不崩", UpdateService.ParseRelease(badJson, out err) == null, err);
        Check("坏 JSON 原因可读", err.Contains("格式"), err);

        // 只有非 exe 资产：应该判为"没有可下载的安装包"，而不是拿 zip 去执行
        const string NoExeRelease = @"{
          ""tag_name"": ""v1.9.0"", ""name"": ""x"", ""body"": """",
          ""draft"": false, ""prerelease"": false, ""html_url"": ""https://github.com/o/r"",
          ""assets"": [ { ""name"": ""source.zip"", ""size"": 1,
                          ""browser_download_url"": ""https://github.com/o/r/releases/download/v1.9.0/source.zip"" } ]
        }";
        var na = UpdateService.ParseRelease(NoExeRelease, out err);
        Check("没有 exe 时 HasAsset=false", na != null && !na.HasAsset,
              na == null ? err : na.AssetName);

        Console.WriteLine("[下载地址白名单：更新器被劫持等于任意代码执行]");
        // 非 https、非 GitHub 域名的地址一律不收，宁可退化到"打开下载页"
        var evil = FullRelease.Replace(
            @"""browser_download_url"": ""https://github.com/o/r/releases/download/v1.9.0/QuickPreview-Setup-1.9.0-x64.exe""",
            @"""browser_download_url"": ""http://evil.example.com/QuickPreview-Setup-1.9.0-x64.exe""");
        var ev = UpdateService.ParseRelease(evil, out err);
        Check("http 外部地址被拒", ev != null && !ev.HasAsset, ev == null ? err : ev.AssetUrl);

        var okUrl = FullRelease.Replace(
            @"https://github.com/o/r/releases/download/v1.9.0/QuickPreview-Setup-1.9.0-x64.exe",
            @"https://objects.githubusercontent.com/github-production-release-asset/x/y");
        var ok = UpdateService.ParseRelease(okUrl, out err);
        Check("objects.githubusercontent.com 放行", ok != null && ok.HasAsset, ok == null ? err : ok.AssetUrl);

        var badDigest = FullRelease.Replace(
            @"""digest"": ""sha256:A9FC105756CFF5A364F9742CE4883FC1CB1541B67EDACDA870D18EDA68AEB3F3""",
            @"""digest"": ""md5:abc""");
        var bd = UpdateService.ParseRelease(badDigest, out err);
        Check("非 sha256 的 digest 视为无摘要", bd != null && bd.AssetSha256 == "",
              bd == null ? err : bd.AssetSha256);

        Console.WriteLine();
        Console.WriteLine(pass + " passed, " + fail + " failed");
        return fail == 0 ? 0 : 1;
    }
}
'''


def main():
    if not os.path.exists(DOTNET):
        print("找不到 dotnet：" + DOTNET)
        return 3

    work = tempfile.mkdtemp(prefix="qp_update_")
    try:
        with open(os.path.join(work, "updatetest.csproj"), "w", encoding="utf-8") as f:
            f.write(CSPROJ)
        with open(os.path.join(work, "Stubs.cs"), "w", encoding="utf-8") as f:
            f.write(STUBS)
        with open(os.path.join(work, "Program.cs"), "w", encoding="utf-8") as f:
            f.write(PROGRAM)
        for name in ("UpdateService.cs", "Logger.cs"):
            shutil.copyfile(os.path.join(SRC_DIR, name), os.path.join(work, name))

        env = dict(os.environ)
        env["DOTNET_ROOT"] = os.path.dirname(DOTNET)
        # 清掉测试钩子，保证白名单断言在"生产模式"下跑
        env.pop("QP_UPDATE_API", None)

        build = subprocess.run([DOTNET, "build", "-c", "Release", "--nologo", "-v", "q"],
                               cwd=work, capture_output=True, env=env)
        if build.returncode != 0:
            print("编译失败：")
            print(build.stdout.decode("utf-8", "replace")[-3000:])
            print(build.stderr.decode("utf-8", "replace")[-2000:])
            return 2

        exe = os.path.join(work, "bin", "Release", "net8.0", "updatetest.exe")
        run = subprocess.run([exe], cwd=work, capture_output=True, env=env)
        out = run.stdout.decode("utf-8", "replace")
        print(out.rstrip())
        return run.returncode
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
