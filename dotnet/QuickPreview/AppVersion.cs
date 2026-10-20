using System;
using System.Diagnostics;
using System.Reflection;

namespace QuickPreview
{
    /// <summary>
    /// 版本号单一来源：取自程序集版本（由 QuickPreview.csproj 的 &lt;AssemblyVersion&gt; 生成）。
    /// 版本规则（务必遵守）：
    ///   1) 仅修复问题 → 第 3 位 +1（如 1.1.0 → 1.1.1）
    ///   2) 含功能需求 → 第 2 位 +1（如 1.1.0 → 1.2.0），打包前须确认
    ///   3) 架构级重构/不兼容变更 → 第 1 位 +1
    /// 改动版本号时同步更新：QuickPreview.csproj、dotnet\setup.iss、package.json
    /// </summary>
    public static class AppVersion
    {
        private static readonly Lazy<string> _current = new Lazy<string>(Read);

        public static string Current => _current.Value;

        private static string Read()
        {
            try
            {
                var v = Assembly.GetExecutingAssembly().GetName().Version;
                if (v != null)
                    return v.Major + "." + v.Minor + "." + Math.Max(v.Build, 0);
            }
            catch { }

            try
            {
                var fvi = FileVersionInfo.GetVersionInfo(Environment.ProcessPath ?? string.Empty);
                if (!string.IsNullOrEmpty(fvi.FileVersion)) return fvi.FileVersion;
            }
            catch { }

            return "0.0.0";
        }
    }
}
