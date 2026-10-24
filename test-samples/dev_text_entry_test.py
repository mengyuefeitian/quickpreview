# -*- coding: utf-8 -*-
"""重命名时按空格被预览抢走的 bug —— TextEntryProbe 判定逻辑断言。

为什么要有这个用例：
    资源管理器里重命名文件/文件夹时，输入法选字是按空格的。全局钩子只看
    「前台窗口是不是文件窗口」，而重命名框就在文件窗口里，于是空格被吞掉去开预览，
    输入法永远选不上字、重命名必然失败。
    TextEntryProbe 负责回答「此刻是不是在输入框里打字」，必须满足两个方向：
      · 有输入框焦点 → 必须判为 true（否则重命名还是坏的）
      · 文件列表有焦点 → 必须判为 false（否则空格再也打不开预览）

做法：现场建一个 console 工程，把 TextEntryProbe.cs 原样编进去，
用原生 CreateWindowEx 造一个真正的 "Edit" 控件（就是资源管理器重命名框的类名）
来断言，不依赖真实重命名、不依赖按键模拟、不依赖 GPU。

用法：python test-samples/dev_text_entry_test.py
退出码 0 = 全部通过。
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DOTNET = os.path.join(os.path.dirname(REPO), ".dotnet-sdk", "dotnet.exe")
SRC = os.path.join(REPO, "dotnet", "QuickPreview", "TextEntryProbe.cs")

CSPROJ = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <AssemblyName>textentrytest</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.cs" />
    <Compile Include="%s" />
  </ItemGroup>
</Project>
""" % SRC

PROGRAM = r'''using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using QuickPreview;

static class T
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style,
        int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);

    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    delegate bool EnumProc(IntPtr hWnd, IntPtr p);

    const uint WS_CHILD = 0x40000000;
    const uint WS_VISIBLE = 0x10000000;

    static int pass, fail;

    static void Check(string name, bool actual, bool expect, string detail)
    {
        bool ok = actual == expect;
        if (ok) pass++; else fail++;
        Console.WriteLine("  " + (ok ? "PASS" : "FAIL") + "  " + name
            + (string.IsNullOrEmpty(detail) ? "" : "  — " + detail));
    }

    static string Cls(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    /// <summary>找任意一个已打开的资源管理器窗口（不要求它在最前面，不抢焦点）。</summary>
    static IntPtr FindExplorer()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) =>
        {
            string c = Cls(h);
            if (c == "CabinetWClass" || c == "ExploreWClass") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    [STAThread]
    static int Main()
    {
        Console.WriteLine("=== 类名判定（纯字符串，逐个断言）===");
        object[][] cases = new object[][]
        {
            // 资源管理器重命名框 / 地址栏就是 Edit
            new object[] { "Edit",            true  },
            new object[] { "RichEdit",        true  },
            new object[] { "RichEdit20W",     true  },
            new object[] { "RichEdit50W",     true  },
            new object[] { "RichEditD2DPT",   true  },
            new object[] { "SearchEditBox",   true  },
            new object[] { "Scintilla",       true  },
            new object[] { "TEdit",           true  },
            // 这些不能被误判，否则空格再也打不开预览
            new object[] { "CabinetWClass",   false },
            new object[] { "DirectUIHWND",    false },
            new object[] { "SHELLDLL_DefView",false },
            new object[] { "Chrome_WidgetWin_0", false },
            new object[] { "SysListView32",   false },
            new object[] { "",                false },
            new object[] { null,              false },
        };
        foreach (var c in cases)
            Check("IsEditClass(" + (c[0] ?? "null") + ")", TextEntryProbe.IsEditClass((string)c[0]), (bool)c[1], "");

        Console.WriteLine("");
        Console.WriteLine("=== 真实窗口探测 ===");

        Application.EnableVisualStyles();
        // 放到屏幕外：只是为了让子控件能拿到焦点，不能挡住用户
        var form = new Form
        {
            Text = "qp-text-entry-test",
            StartPosition = FormStartPosition.Manual,
            Location = new System.Drawing.Point(-6000, -6000),
            Size = new System.Drawing.Size(460, 220),
            ShowInTaskbar = false
        };
        form.Show();

        string why;
        // ① 焦点在窗体本身（相当于资源管理器里点了文件列表）→ 必须放行空格
        SetFocus(form.Handle);
        bool plain = TextEntryProbe.IsTextEntryActiveFor(form.Handle, out why);
        Check("窗体内无输入框 → 不算输入中", plain, false, why ?? "");

        // ② 原生 EDIT 拿到焦点 → 必须判为输入中（这就是重命名框的实际形态）
        IntPtr edit = CreateWindowExW(0, "Edit", "测试文字",
            WS_CHILD | WS_VISIBLE, 10, 10, 400, 24,
            form.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (edit == IntPtr.Zero)
        {
            Check("创建 Edit 控件", false, true, "CreateWindowExW 失败");
        }
        else
        {
            SetFocus(edit);
            bool inEdit = TextEntryProbe.IsTextEntryActiveFor(form.Handle, out why);
            Check("焦点在 Edit（重命名框）→ 判为输入中", inEdit, true, why ?? "");

            // ③ 焦点移开 → 又回到"可以预览"
            SetFocus(form.Handle);
            bool after = TextEntryProbe.IsTextEntryActiveFor(form.Handle, out why);
            Check("焦点离开 Edit → 恢复可预览", after, false, why ?? "");

            DestroyWindow(edit);
        }
        form.Close();
        form.Dispose();

        // ④ 对着真实资源管理器窗口：没有重命名时必须判为"没在输入"
        IntPtr exp = FindExplorer();
        if (exp == IntPtr.Zero)
        {
            Console.WriteLine("  SKIP  没找到已打开的资源管理器窗口，跳过真实窗口检查");
        }
        else
        {
            bool inExp = TextEntryProbe.IsTextEntryActiveFor(exp, out why);
            // 用户此刻若正好在地址栏/搜索框打字，判成 true 也是对的，因此只提示不算失败
            if (inExp)
            {
                Console.WriteLine("  SKIP  资源管理器窗口当前焦点确实在输入框上（" + why + "），跳过");
            }
            else
            {
                Check("真实资源管理器窗口（无重命名）→ 可预览", inExp, false, "class=" + Cls(exp));
            }
        }

        Console.WriteLine("");
        Console.WriteLine(fail == 0 ? "失败项：0" : "失败项：" + fail);
        return fail == 0 ? 0 : 1;
    }
}
'''


def main():
    if not os.path.exists(SRC):
        print("找不到源文件：" + SRC)
        return 2
    tmp = tempfile.mkdtemp(prefix="qptextentry")
    with open(os.path.join(tmp, "t.csproj"), "w", encoding="utf-8") as f:
        f.write(CSPROJ)
    with open(os.path.join(tmp, "Program.cs"), "w", encoding="utf-8") as f:
        f.write(PROGRAM)

    env = dict(os.environ)
    env["DOTNET_ROOT"] = os.path.dirname(DOTNET)
    env["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
    env["DOTNET_NOLOGO"] = "1"

    print("=== TextEntryProbe 断言 ===")
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


if __name__ == "__main__":
    sys.exit(main())
