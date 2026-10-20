using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace QuickPreview
{
    /// <summary>
    /// 桌面选中项读取。
    ///
    /// 【重要·踩过两次坑，勿改回旧写法】
    ///
    /// 坑 1：用"前台窗口 hwnd 去 ShellWindows 里精确匹配"。
    ///       桌面的 ShellWindow 的 hwnd 与 SHELLDLL_DefView 不是同一个，永远匹配不到。
    ///
    /// 坑 2：改用"LocationName 含桌面"来找出桌面窗口，看似能用，实际有致命缺陷——
    ///       任何**位于桌面文件夹的普通资源管理器窗口**，LocationName 同样是"桌面"！
    ///       用户只要开着两个桌面文件夹窗口（一个选中回收站、一个选中"文档"），
    ///       我们就会把它们的选中项当成桌面选中项，表现为"桌面上预览任何文件，
    ///       显示的都是文档文件夹的预览"。
    ///
    /// 现在的做法（主通道）：直接读桌面图标列表 SysListView32 的选中项。
    ///   1) LVM_GETNEXTITEM + LVNI_SELECTED/FOCUSED 拿选中下标（无需跨进程内存，
    ///      不依赖 LVITEM.lParam——新版 shell 对桌面项的 lParam 恒为 0，所以
    ///      "LVM_GETITEM 读 lParam 再解 PIDL"的老路走不通）；
    ///   2) LVM_GETITEMTEXTW 在目标进程里申请缓冲区，让列表控件自己把显示名写进去。
    ///   3) 用显示名在桌面目录里解析出真实路径（兼容隐藏扩展名与 .lnk 快捷方式）。
    /// 回退通道：ShellWindows，但**排除 CabinetWClass**（普通资源管理器窗口）。
    /// </summary>
    public static class DesktopSelection
    {
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter,
                                                 string lpszClass, string lpszWindow);

        [DllImport("user32.dll")]
        private static extern IntPtr GetParent(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr addr, IntPtr size,
                                                   uint type, uint protect);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr addr, IntPtr size, uint type);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr addr,
                                                    byte[] buffer, IntPtr size, out IntPtr read);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr addr,
                                                     byte[] buffer, IntPtr size, out IntPtr written);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        // 列表控件消息
        private const uint LVM_GETNEXTITEM = 0x100C;
        private const uint LVM_GETITEMTEXTW = 0x1073;
        private const int LVNI_SELECTED = 0x0002;
        private const int LVNI_FOCUSED = 0x0001;

        private const uint PROCESS_VM_OPERATION = 0x0008;
        private const uint PROCESS_VM_READ = 0x0010;
        private const uint PROCESS_VM_WRITE = 0x0020;
        private const uint PROCESS_QUERY_INFORMATION = 0x0400;

        private const uint MEM_COMMIT = 0x1000;
        private const uint MEM_RESERVE = 0x2000;
        private const uint MEM_RELEASE = 0x8000;
        private const uint PAGE_READWRITE = 0x04;

        // 中文系统为「桌面」，英文系统为「Desktop」
        private static readonly string[] DesktopLocations = { "桌面", "Desktop" };

        private static bool IsDesktopLocation(string loc)
        {
            if (string.IsNullOrEmpty(loc)) return false;
            foreach (var d in DesktopLocations)
                if (loc.IndexOf(d, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private static string ClassNameOf(IntPtr h)
        {
            var sb = new StringBuilder(256);
            try { GetClassName(h, sb, sb.Capacity); } catch { }
            return sb.ToString();
        }

        /// <summary>获取桌面的 SHELLDLL_DefView 窗口句柄（兼容 Progman 与 WorkerW 两种宿主）。</summary>
        public static IntPtr FindDefView()
        {
            IntPtr progman = FindWindow("Progman", null);
            if (progman != IntPtr.Zero)
            {
                var v = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (v != IntPtr.Zero) return v;
            }

            // Win10/11 桌面切换壁纸时会出现 WorkerW 分层窗口
            IntPtr worker = IntPtr.Zero;
            for (int i = 0; i < 10; i++)
            {
                worker = FindWindowEx(IntPtr.Zero, worker, "WorkerW", null);
                if (worker == IntPtr.Zero) break;
                var v = FindWindowEx(worker, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (v != IntPtr.Zero) return v;
            }
            return IntPtr.Zero;
        }

        /// <summary>
        /// 判断前台窗口是否处于「桌面」上下文。
        /// 点击桌面图标后焦点通常落在 SysListView32 上，而不是 Progman，
        /// 因此必须往上查祖先链是否挂在 SHELLDLL_DefView 下，否则会漏判。
        /// </summary>
        public static bool IsDesktopContext(IntPtr fg)
        {
            if (fg == IntPtr.Zero) return false;

            string cls = ClassNameOf(fg);
            if (string.Equals(cls, "Progman", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(cls, "WorkerW", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(cls, "SHELLDLL_DefView", StringComparison.OrdinalIgnoreCase))
                return true;

            if (string.Equals(cls, "SysListView32", StringComparison.OrdinalIgnoreCase))
            {
                IntPtr p = fg;
                for (int i = 0; i < 8; i++)
                {
                    p = GetParent(p);
                    if (p == IntPtr.Zero) break;
                    if (string.Equals(ClassNameOf(p), "SHELLDLL_DefView", StringComparison.OrdinalIgnoreCase))
                        return true;
                }
            }

            return false;
        }

        /// <summary>桌面文件夹路径（含重定向到 OneDrive 的情况）。</summary>
        public static string DesktopDir()
        {
            try
            {
                var d = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                if (!string.IsNullOrEmpty(d) && Directory.Exists(d)) return d;
                d = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                if (!string.IsNullOrEmpty(d) && Directory.Exists(d)) return d;
            }
            catch { }
            return null;
        }

        /// <summary>
        /// 读取桌面选中项。
        /// 结果可能包含无法解析成文件系统路径的虚拟项（回收站/此电脑等），调用方需再过滤一次。
        /// </summary>
        public static List<string> GetSelection()
        {
            var result = ReadDesktopListViewSelection();
            if (result.Count > 0)
            {
                Log.I(LogKind.Hook, "[桌面] 图标列表命中选中项 " + result.Count + " 个：" + Join(result, 6));
                return result;
            }

            Log.W(LogKind.Hook, "[桌面] 图标列表未取到选中项，回退 ShellWindows（排除普通资源管理器窗口）");
            return GetSelectionViaShellWindows();
        }

        // ---------- 主通道：桌面图标 ListView ----------
        private static List<string> ReadDesktopListViewSelection()
        {
            var result = new List<string>();
            IntPtr hProc = IntPtr.Zero;
            IntPtr remote = IntPtr.Zero;

            try
            {
                IntPtr defView = FindDefView();
                if (defView == IntPtr.Zero)
                {
                    Log.D(LogKind.Hook, "[桌面] 未找到 SHELLDLL_DefView");
                    return result;
                }

                IntPtr list = FindWindowEx(defView, IntPtr.Zero, "SysListView32", null);
                if (list == IntPtr.Zero)
                {
                    Log.D(LogKind.Hook, "[桌面] 未找到桌面 SysListView32");
                    return result;
                }

                uint pid;
                GetWindowThreadProcessId(list, out pid);
                if (pid == 0) return result;

                hProc = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ
                                    | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION, false, pid);
                if (hProc == IntPtr.Zero)
                {
                    Log.W(LogKind.Hook, "[桌面] 打开桌面宿主进程失败（err="
                        + Marshal.GetLastWin32Error() + "），常见于本程序以管理员运行");
                    return result;
                }

                const int ITEM_STRUCT = 64;    // LVITEMW 大小为 64 字节（x64）
                const int TEXT_CHARS = 520;    // 显示名上限
                remote = VirtualAllocEx(hProc, IntPtr.Zero,
                    (IntPtr)(ITEM_STRUCT + TEXT_CHARS * 2), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
                if (remote == IntPtr.Zero)
                {
                    Log.W(LogKind.Hook, "[桌面] 申请远端缓冲区失败（err=" + Marshal.GetLastWin32Error() + "）");
                    return result;
                }
                IntPtr remoteText = new IntPtr(remote.ToInt64() + ITEM_STRUCT);

                // 收集所有选中下标
                var idxList = new List<int>();
                int start = -1;
                for (int guard = 0; guard < 512; guard++)
                {
                    IntPtr r = SendMessage(list, LVM_GETNEXTITEM, (IntPtr)start, (IntPtr)LVNI_SELECTED);
                    int idx = r.ToInt32();
                    if (idx < 0) break;
                    idxList.Add(idx);
                    start = idx;
                }

                // 没有多选时，用"焦点项"兜底（桌面刚点一下图标，选中态可能仍在刷新）
                if (idxList.Count == 0)
                {
                    IntPtr r = SendMessage(list, LVM_GETNEXTITEM, (IntPtr)(-1), (IntPtr)LVNI_FOCUSED);
                    int idx = r.ToInt32();
                    if (idx >= 0)
                    {
                        idxList.Add(idx);
                        Log.D(LogKind.Hook, "[桌面] 无选中项，退化为焦点项 #" + idx);
                    }
                }

                if (idxList.Count == 0)
                {
                    Log.I(LogKind.Hook, "[桌面] 桌面当前没有选中任何图标");
                    return result;
                }

                string desktop = DesktopDir();

                foreach (int idx in idxList)
                {
                    string name = ReadItemText(hProc, list, remote, remoteText, idx, TEXT_CHARS);
                    if (string.IsNullOrEmpty(name)) continue;

                    string path = ResolveDesktopItem(name, desktop);
                    if (string.IsNullOrEmpty(path))
                    {
                        Log.D(LogKind.Hook, "[桌面] 项「" + name + "」无法映射为文件路径（虚拟项或解析失败），跳过");
                        continue;
                    }
                    if (!result.Contains(path)) result.Add(path);
                    Log.D(LogKind.Hook, "[桌面] 项[" + idx + "] 「" + name + "」→ " + path);
                }
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Hook, "[桌面] 读取桌面图标列表失败", ex);
            }
            finally
            {
                try { if (remote != IntPtr.Zero) VirtualFreeEx(hProc, remote, IntPtr.Zero, MEM_RELEASE); } catch { }
                try { if (hProc != IntPtr.Zero) CloseHandle(hProc); } catch { }
            }

            return result;
        }

        private static string ReadItemText(IntPtr hProc, IntPtr list, IntPtr remote,
                                          IntPtr remoteText, int idx, int ITEM_CHARS)
        {
            try
            {
                int structSize = 64;
                var buf = new byte[structSize];
                BitConverter.GetBytes(idx).CopyTo(buf, 4);                        // iItem
                BitConverter.GetBytes(0).CopyTo(buf, 8);                          // iSubItem
                BitConverter.GetBytes(remoteText.ToInt64()).CopyTo(buf, 24);      // pszText
                BitConverter.GetBytes(ITEM_CHARS).CopyTo(buf, 32);                // cchTextMax

                IntPtr written;
                if (!WriteProcessMemory(hProc, remote, buf, (IntPtr)structSize, out written))
                {
                    Log.W(LogKind.Hook, "[桌面] 写入 LVITEM 失败（err=" + Marshal.GetLastWin32Error() + "）");
                    return null;
                }

                IntPtr len = SendMessage(list, LVM_GETITEMTEXTW, (IntPtr)idx, remote);
                if (len.ToInt32() <= 0) return null;

                int bytes = ITEM_CHARS * 2;
                var text = new byte[bytes];
                IntPtr read;
                if (!ReadProcessMemory(hProc, remoteText, text, (IntPtr)bytes, out read)) return null;

                var s = Encoding.Unicode.GetString(text);
                int z = s.IndexOf('\0');
                return (z >= 0 ? s.Substring(0, z) : s).Trim();
            }
            catch (Exception ex)
            {
                Log.W(LogKind.Hook, "[桌面] 读取图标文本异常：" + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// 把桌面图标的显示名解析成真实路径。
        /// 显示名可能是：文件名（资源管理器设置了隐藏扩展名）、文件夹名、快捷方式名（不含 .lnk）。
        /// </summary>
        private static string ResolveDesktopItem(string name, string desktop)
        {
            if (string.IsNullOrEmpty(name)) return null;
            if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;

            if (!string.IsNullOrEmpty(desktop))
            {
                string direct = Path.Combine(desktop, name);
                try
                {
                    if (Directory.Exists(direct) || File.Exists(direct)) return direct;
                }
                catch { }

                string lnk = direct + ".lnk";
                try
                {
                    if (File.Exists(lnk)) return ResolveShortcut(lnk) ?? lnk;
                }
                catch { }

                // 显示名省略了扩展名：在桌面目录里按"无扩展名同名"匹配
                try
                {
                    foreach (var f in Directory.GetFiles(desktop))
                    {
                        if (!string.Equals(Path.GetFileNameWithoutExtension(f), name,
                                           StringComparison.OrdinalIgnoreCase))
                            continue;
                        if (f.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                            return ResolveShortcut(f) ?? f;
                        return f;
                    }
                }
                catch { }
            }

            return null;
        }

        /// <summary>解析 .lnk 快捷方式的目标路径（目标不存在则返回 null）。</summary>
        private static string ResolveShortcut(string lnkPath)
        {
            try
            {
                var t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return null;
                dynamic ws = Activator.CreateInstance(t);
                dynamic sc = ws.CreateShortcut(lnkPath);
                string target = Convert.ToString(sc.TargetPath);
                if (!string.IsNullOrEmpty(target) && (File.Exists(target) || Directory.Exists(target)))
                    return target;
            }
            catch (Exception ex)
            {
                Log.D(LogKind.Hook, "[桌面] 解析快捷方式失败：" + lnkPath + " → " + ex.Message);
            }
            return null;
        }

        // ---------- 回退通道：ShellWindows ----------
        private static List<string> GetSelectionViaShellWindows()
        {
            var result = new List<string>();

            try
            {
                var shellType = Type.GetTypeFromProgID("Shell.Application");
                if (shellType == null)
                {
                    Log.E(LogKind.Hook, "[桌面] Shell.Application COM 不可用");
                    return result;
                }

                dynamic shell = Activator.CreateInstance(shellType);
                int matched = 0;

                foreach (var w in shell.Windows())
                {
                    string cls = "?";
                    try
                    {
                        long hwnd = Convert.ToInt64(w.HWND);
                        cls = ClassNameOf(new IntPtr(hwnd));
                    }
                    catch { }

                    // CabinetWClass = 普通资源管理器窗口。它也可能"位于桌面文件夹"，
                    // 但它反映的是那个窗口里的选中项，不是桌面上的选中项 —— 必须排除。
                    if (string.Equals(cls, "CabinetWClass", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(cls, "ExploreWClass", StringComparison.OrdinalIgnoreCase))
                        continue;

                    string loc;
                    try { loc = Convert.ToString(w.LocationName); }
                    catch { continue; }
                    if (!IsDesktopLocation(loc)) continue;

                    matched++;
                    try
                    {
                        var doc = w.Document;
                        if (doc == null) continue;
                        foreach (var it in doc.SelectedItems())
                        {
                            string p = Convert.ToString(it.Path);
                            if (!string.IsNullOrEmpty(p) && !result.Contains(p)) result.Add(p);
                        }
                    }
                    catch (Exception ex)
                    {
                        Log.W(LogKind.Hook, "[桌面] 读取选中项失败：" + ex.Message);
                    }
                }

                Log.I(LogKind.Hook, "[桌面] ShellWindows 回退：桌面类窗口 " + matched
                    + " 个，选中项 " + result.Count + " 个：" + Join(result, 6));
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Hook, "[桌面] ShellWindows 回退失败", ex);
            }

            return result;
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
