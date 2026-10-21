using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace QuickPreview
{
    /// <summary>
    /// 读取当前前台「文件资源管理器」窗口中选中的文件（通过 Shell.Application COM）。
    /// 每一步都写日志，便于定位「按空格没反应」的原因。
    /// </summary>
    public static class ExplorerSelection
    {
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        public static string ClassNameOf(IntPtr hWnd)
        {
            var sb = new StringBuilder(256);
            try { GetClassName(hWnd, sb, sb.Capacity); } catch { }
            return sb.ToString();
        }

        public static string TitleOf(IntPtr hWnd)
        {
            var sb = new StringBuilder(512);
            try { GetWindowText(hWnd, sb, sb.Capacity); } catch { }
            return sb.ToString();
        }

        /// <summary>
        /// 可能承载「文件选中项」的窗口类：文件资源管理器、桌面、打开/保存对话框。
        /// 仅使用 Win32 调用即可判断，因此可以在键盘钩子回调（输入同步调用）内安全执行，
        /// 用于快速决定要不要吞掉空格键——避免在任何软件里打字都被影响。
        /// </summary>
        private static readonly string[] CandidateClasses =
        {
            "CabinetWClass",        // 文件资源管理器（Win7 ~ Win11）
            "ExploreWClass",        // 旧版资源管理器
            "Progman",              // 桌面
            "WorkerW",              // 桌面（含壁纸层）
            "SHELLDLL_DefView",     // 桌面/资源管理器文件视图
            "SysListView32",        // 桌面的图标列表（点击桌面后焦点通常落在它上面）
            "#32770"                // 通用对话框（打开/保存）——可预览已选文件
        };

        public static bool IsCandidateClass(string className)
        {
            if (string.IsNullOrEmpty(className)) return false;
            foreach (var c in CandidateClasses)
                if (string.Equals(c, className, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>
        /// 读取选中项。
        /// 注意：本方法内部有跨进程 COM 调用，**绝不能在键盘钩子回调里同步调用**
        /// （会抛 RPC_E_CANTCALLOUT_ININPUTSYNCCALL），必须由异步上下文调用。
        /// </summary>
        public static List<string> GetForegroundSelection()
        {
            var result = new List<string>();

            try
            {
                IntPtr fg = GetForegroundWindow();
                string fgClass = ClassNameOf(fg);
                string fgTitle = TitleOf(fg);
                Log.D(LogKind.Hook, string.Format("前台窗口 hwnd={0} class={1} title={2}",
                    fg.ToInt64(), fgClass, fgTitle));

                // 桌面：前台 hwnd 与桌面 ShellWindow 的 hwnd 不同，精确匹配必然落空，
                // 需要单独按 LocationName=="桌面" 去找窗口再读 SelectedItems。
                if (DesktopSelection.IsDesktopContext(fg))
                {
                    Log.D(LogKind.Hook, "前台处于桌面上下文（class=" + fgClass + "），走桌面专用读取");
                    return DesktopSelection.GetSelection();
                }

                var shellType = Type.GetTypeFromProgID("Shell.Application");
                if (shellType == null)
                {
                    Log.E(LogKind.Hook, "Shell.Application COM 不可用（无法读取选中项）");
                    return result;
                }

                dynamic shell = Activator.CreateInstance(shellType);
                Log.D(LogKind.Hook, "Shell.Application 已创建，正在枚举 ShellWindows …");
                dynamic windows = shell.Windows();
                Log.D(LogKind.Hook, "ShellWindows 枚举接口已获取");

                int index = 0;
                foreach (var w in windows)
                {
                    index++;
                    try
                    {
                        long hwnd = Convert.ToInt64(w.HWND);
                        bool isForeground = hwnd == fg.ToInt64();
                        Log.D(LogKind.Hook, string.Format("shell 窗口#{0} hwnd={1} name={2} location={3}{4}",
                            index, hwnd, SafeName(w), SafeLocation(w), isForeground ? "  <== 前台" : ""));

                        if (!isForeground) continue;

                        // 同一个 hwnd 可能对应多个 ShellWindow（资源管理器多标签页、
                        // 以及桌面那个 ShellWindow）。只看 hwnd 会把"桌面上次选中的视频"
                        // 混进结果 —— 表现为「在桌面文件夹里预览任何文件，显示的都是那个视频」。
                        // 这里加两道闸：窗口 class 必须与前台一致，选中项必须属于该窗口的目录。
                        string wCls = ClassNameOf(new IntPtr(hwnd));
                        if (!string.IsNullOrEmpty(wCls)
                            && !string.Equals(wCls, fgClass, StringComparison.OrdinalIgnoreCase))
                        {
                            Log.D(LogKind.Hook, string.Format(
                                "跳过窗口#{0}：hwnd 与前台相同但 class={1} ≠ 前台 {2}", index, wCls, fgClass));
                            continue;
                        }

                        string locUrl = null;
                        try { locUrl = Convert.ToString(w.LocationURL); } catch { }
                        string locDir = FileUrlToDir(locUrl);
                        if (!string.IsNullOrEmpty(locUrl))
                            Log.D(LogKind.Hook, "前台窗口目录：" + locUrl + " → " + (locDir ?? "非文件系统"));

                        var doc = w.Document;
                        if (doc == null)
                        {
                            Log.W(LogKind.Hook, "前台窗口没有 Document 对象（不是资源管理器文件视图，或进程权限不匹配）");
                            continue;
                        }

                        try
                        {
                            var items = doc.SelectedItems();
                            foreach (var it in items)
                            {
                                string p = it.Path;
                                if (string.IsNullOrEmpty(p)) continue;

                                // 选中项必须落在该窗口显示的目录里。
                                // 桌面 ShellWindow 与"桌面文件夹窗口"的 Location 常常都是「桌面」，
                                // 光靠 LocationName 分不开，用真实父目录比对才可靠。
                                if (locDir != null && !SameDir(Path.GetDirectoryName(p), locDir))
                                {
                                    Log.D(LogKind.Hook, "跳过不属于当前窗口目录的选中项：" + p);
                                    continue;
                                }
                                result.Add(p);
                            }
                            Log.I(LogKind.Hook, "读取到选中项 " + result.Count + " 个：" + Join(result, 6));
                        }
                        catch (Exception ex)
                        {
                            Log.W(LogKind.Hook, "doc.SelectedItems() 读取失败：" + ex.Message);
                        }
                    }
                    catch (Exception ex)
                    {
                        Log.D(LogKind.Hook, "遍历 shell 窗口#" + index + " 异常：" + ex.Message);
                    }
                }

                Log.D(LogKind.Hook, "ShellWindows 共 " + index + " 个窗口");
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Hook, "获取前台选中项失败", ex);

                int hr = System.Runtime.InteropServices.Marshal.GetHRForException(ex);
                if (hr == unchecked((int)0x8001010D))
                    Log.E(LogKind.Hook, "命中 RPC_E_CANTCALLOUT_ININPUTSYNCCALL："
                        + "仍在键盘钩子的输入同步调用中执行了 COM 调用，必须改为异步执行。");
                else if (hr == unchecked((int)0x80070005))
                    Log.E(LogKind.Hook, "命中 E_ACCESSDENIED：本程序与资源管理器权限级别不一致"
                        + "（常见于本程序以管理员运行、资源管理器为普通权限）。请以普通权限重启本程序。");
            }

            return result;
        }

        private static string SafeName(dynamic w)
        {
            try { return Convert.ToString(w.Name); } catch { return "?"; }
        }

        private static string SafeLocation(dynamic w)
        {
            try { return Convert.ToString(w.LocationName); } catch { return "?"; }
        }

        /// <summary>file:/// 形式的 LocationURL → 本地目录；库 / 搜索结果这类虚拟位置返回 null。</summary>
        private static string FileUrlToDir(string url)
        {
            if (string.IsNullOrEmpty(url)) return null;
            if (!url.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return null;
            try
            {
                var u = new Uri(url);
                return string.IsNullOrEmpty(u.LocalPath) ? null : u.LocalPath.TrimEnd('\\', '/');
            }
            catch { return null; }
        }

        /// <summary>目录比较：忽略大小写与末尾分隔符。任一为空则视为匹配（不误杀）。</summary>
        private static bool SameDir(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return true;
            return string.Equals(a.TrimEnd('\\', '/'), b.TrimEnd('\\', '/'),
                                 StringComparison.OrdinalIgnoreCase);
        }

        private static string Join(List<string> list, int max)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < list.Count && i < max; i++)
            {
                if (i > 0) sb.Append(" | ");
                sb.Append(list[i]);
            }
            if (list.Count > max) sb.Append(" | …(+" + (list.Count - max) + ")");
            return sb.ToString();
        }
    }
}
