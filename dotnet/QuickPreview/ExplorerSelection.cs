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

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter,
                                                  string lpszClass, string lpszWindow);

        /// <summary>
        /// IShellBrowser（IID 000214E2-…-C000-000000000046），只取 IOleWindow::GetWindow()。
        /// 对 InterfaceIsIUnknown 接口，C# 声明的方法从 vtable 槽 3 开始（前三个是 IUnknown），
        /// 因此这里的 GetWindow() 正好落在槽 3，与 IOleWindow 的布局一致。
        /// 用它反查「这个 ShellWindow 属于资源管理器里的哪个标签页窗口」。
        /// </summary>
        [ComImport, Guid("000214E2-0000-0000-C000-000000000046")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellBrowser
        {
            IntPtr GetWindow();
        }

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

                // Windows 11 22H2+ 的资源管理器支持多标签页：同一个顶层窗口（hwnd）下挂了
                // 多个 ShellWindow（每个标签页一个），而它们的 HWND 属性全都等于顶层 hwnd
                // —— 只比 hwnd 根本分不出当前看的是哪个标签页。
                // 判据：资源管理器给每个标签页建了一个 ShellTabWindowClass 子窗口，
                // 且 z-order 最上面那个（ClassNN 里的 ShellTabWindowClass1）就是当前激活的标签页；
                // FindWindowEx 按 z-order 返回第一个匹配的子窗口，正好拿到它。
                // 再对每个 ShellWindow 用 IShellBrowser::GetWindow() 反查它属于哪个标签页，两边一比即可锁定。
                IntPtr activeTab = FindWindowEx(fg, IntPtr.Zero, "ShellTabWindowClass", null);
                Log.D(LogKind.Hook, "活动标签页子窗口 hwnd=" + activeTab.ToInt64()
                    + (activeTab == IntPtr.Zero
                        ? "（该窗口没有标签页，按整窗口处理）"
                        : "（多标签页：只认这一个标签）"));

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

                // strict：hwnd + class + 活动标签三者都命中（多标签页下的正确答案）
                var strict = new List<dynamic>();
                // loose：只命中 hwnd + class —— 标签 hwnd 取不到时的回退，
                // 绝不能因为识别失败就让「按空格」彻底没反应。
                var loose = new List<dynamic>();

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
                        // 以及桌面那个 ShellWindow）。先看 class 是否与前台一致。
                        string wCls = ClassNameOf(new IntPtr(hwnd));
                        if (!string.IsNullOrEmpty(wCls)
                            && !string.Equals(wCls, fgClass, StringComparison.OrdinalIgnoreCase))
                        {
                            Log.D(LogKind.Hook, string.Format(
                                "跳过窗口#{0}：hwnd 与前台相同但 class={1} ≠ 前台 {2}", index, wCls, fgClass));
                            continue;
                        }

                        loose.Add(w);

                        if (activeTab == IntPtr.Zero)
                        {
                            strict.Add(w);   // 没有标签页，无从也无须区分
                            continue;
                        }

                        IntPtr? tab = TabHwndOf(w);
                        if (tab.HasValue && tab.Value == activeTab)
                        {
                            Log.D(LogKind.Hook, string.Format(
                                "窗口#{0} 属于活动标签页（tab hwnd={1}）", index, tab.Value.ToInt64()));
                            strict.Add(w);
                        }
                        else
                        {
                            Log.D(LogKind.Hook, string.Format(
                                "跳过窗口#{0}：非活动标签页（tab hwnd={1}，活动={2}）",
                                index, tab.HasValue ? tab.Value.ToInt64().ToString() : "取不到",
                                activeTab.ToInt64()));
                        }
                    }
                    catch (Exception ex)
                    {
                        Log.D(LogKind.Hook, "遍历 shell 窗口#" + index + " 异常：" + ex.Message);
                    }
                }

                Log.D(LogKind.Hook, string.Format(
                    "ShellWindows 共 {0} 个窗口；严格命中 {1} 个，宽松命中 {2} 个",
                    index, strict.Count, loose.Count));

                var targets = strict;
                if (targets.Count == 0 && loose.Count > 0)
                {
                    Log.W(LogKind.Hook, "标签页识别未命中（IShellBrowser 取不到或 hwnd 对不上），"
                        + "退化为按整窗口读取，避免按空格完全无反应");
                    targets = loose;
                }

                // 命中即停：多标签页下绝不能把每个标签页的选中项都累加进来，
                // 否则取第一个永远是「标签页1 选中的东西」——在任何标签页里预览都是同一个文件。
                foreach (var w in targets)
                {
                    var picked = ReadSelection(w);
                    if (picked != null && picked.Count > 0)
                    {
                        result.AddRange(picked);
                        break;
                    }
                }
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

        /// <summary>
        /// 取某个 ShellWindow 所属的标签页窗口 hwnd（经 IShellBrowser::GetWindow）。
        /// 取不到返回 null —— 调用方会退化处理，绝不能因为这一步失败就让按空格没反应。
        /// </summary>
        private static IntPtr? TabHwndOf(object w)
        {
            IntPtr pUnk = IntPtr.Zero, pBr = IntPtr.Zero;
            try
            {
                pUnk = Marshal.GetIUnknownForObject(w);
                if (pUnk == IntPtr.Zero) return null;

                Guid iid = typeof(IShellBrowser).GUID;
                int hr = Marshal.QueryInterface(pUnk, ref iid, out pBr);
                if (hr != 0 || pBr == IntPtr.Zero) return null;

                var browser = (IShellBrowser)Marshal.GetObjectForIUnknown(pBr);
                IntPtr h = browser.GetWindow();
                return h == IntPtr.Zero ? (IntPtr?)null : h;
            }
            catch (Exception ex)
            {
                Log.D(LogKind.Hook, "IShellBrowser 取标签 hwnd 失败：" + ex.Message);
                return null;
            }
            finally
            {
                if (pBr != IntPtr.Zero) Marshal.Release(pBr);
                if (pUnk != IntPtr.Zero) Marshal.Release(pUnk);
            }
        }

        /// <summary>
        /// 读取单个 ShellWindow 的选中项；返回 null 表示该窗口没读到（调用方继续试下一个）。
        /// </summary>
        private static List<string> ReadSelection(dynamic w)
        {
            string locDir = null;
            try
            {
                string locUrl = Convert.ToString(w.LocationURL);
                locDir = FileUrlToDir(locUrl);
                if (!string.IsNullOrEmpty(locUrl))
                    Log.D(LogKind.Hook, "窗口目录：" + locUrl + " → " + (locDir ?? "非文件系统"));
            }
            catch { }

            var doc = w.Document;
            if (doc == null)
            {
                Log.W(LogKind.Hook, "窗口没有 Document 对象（不是资源管理器文件视图，或进程权限不匹配）");
                return null;
            }

            try
            {
                var picked = new List<string>();
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
                    picked.Add(p);
                }
                if (picked.Count == 0) return null;

                Log.I(LogKind.Hook, "读取到选中项 " + picked.Count + " 个：" + Join(picked, 6));
                return picked;
            }
            catch (Exception ex)
            {
                Log.W(LogKind.Hook, "doc.SelectedItems() 读取失败：" + ex.Message);
                return null;
            }
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
