using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace QuickPreview
{
    /// <summary>
    /// 查询某个文件类型「当前系统默认用什么程序打开」的友好名称。
    /// 用于把预览窗口的按钮从笼统的「用默认程序打开」改成「使用 Word 打开」
    /// 「使用 Excel 打开」「使用 照片 打开」等。
    /// </summary>
    public static class ShellAssoc
    {
        private const int ASSOCF_INIT_QUERYNONTRIVIAL = 0x00000040;
        private const int ASSOCSTR_FRIENDLYAPPNAME = 4;

        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int AssocQueryStringW(
            int flags, int str, string assoc, string extra,
            StringBuilder outBuf, ref int outBufSize);

        // 同类扩展名只查一次（打开同目录几十个文件时不做重复查询）
        private static readonly Dictionary<string, string> _cache =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        private static readonly object _lock = new object();

        /// <summary>
        /// 返回友好程序名（如 "Word"、"Excel"、"照片"、"记事本"、"Visual Studio Code"）。
        /// 查不到时返回 null，调用方回退到「默认程序」。
        /// </summary>
        public static string FriendlyAppName(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;

            string ext;
            try { ext = (Path.GetExtension(path) ?? string.Empty).ToLowerInvariant(); }
            catch { return null; }
            if (ext.Length == 0) return null;

            lock (_lock)
            {
                if (_cache.TryGetValue(ext, out var cached)) return cached;
            }

            string name = Query(ext);
            lock (_lock) { _cache[ext] = name; }
            return name;
        }

        private static string Query(string ext)
        {
            try
            {
                int size = 1024;
                var sb = new StringBuilder(size);
                int hr = AssocQueryStringW(ASSOCF_INIT_QUERYNONTRIVIAL,
                    ASSOCSTR_FRIENDLYAPPNAME, ext, null, sb, ref size);
                if (hr == 0 && sb.Length > 0)
                {
                    string s = sb.ToString().Trim();
                    // 有些系统会返回一长串命令行，取文件名主干更友好
                    return Clean(s);
                }
            }
            catch (Exception ex)
            {
                Log.D(LogKind.App, "查询默认程序失败（" + ext + "）：" + ex.Message);
            }
            return null;
        }

        private static string Clean(string s)
        {
            if (s.Length == 0) return s;
            // 去掉可能的 "xxx.exe" 后缀与路径
            int slash = s.LastIndexOfAny(new[] { '\\', '/' });
            if (slash >= 0 && slash + 1 < s.Length) s = s.Substring(slash + 1);
            if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                s = s.Substring(0, s.Length - 4);
            // 过长的名字截断，避免按钮被撑爆
            if (s.Length > 24) s = s.Substring(0, 24) + "…";
            return s.Trim();
        }
    }
}
