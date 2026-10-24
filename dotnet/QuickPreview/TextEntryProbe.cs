using System;
using System.Runtime.InteropServices;
using System.Text;

namespace QuickPreview
{
    /// <summary>
    /// 判断「用户此刻是不是正在某个输入框里打字」。
    ///
    /// 背景（用户上报的 bug）：在资源管理器里重命名文件 / 文件夹时，输入法选字是按空格的。
    /// 全局钩子只看「前台窗口是不是文件窗口」，重命名框就在文件窗口里，于是空格被吞掉
    /// 拿去开预览 —— 输入法永远选不上字，重命名直接失败。
    ///
    /// 这里只用 Win32（无 COM），因此可以在键盘钩子的「输入同步调用」上下文里安全调用，
    /// 且必须在 1 毫秒级返回（低层钩子超时会被 Windows 直接摘掉）。
    /// 判断依据两条，任一成立即视为「在输入框里」：
    ///   ① 焦点控件的类名是编辑框（Edit / RichEdit* / *EditBox / Scintilla …）；
    ///   ② 焦点控件有可见的文本光标（caret）—— 用来兜住类名不认识的编辑框，
    ///      资源管理器新版本、第三方外壳都可能换控件实现。
    /// </summary>
    internal static class TextEntryProbe
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct GUITHREADINFO
        {
            public int cbSize;
            public int flags;
            public IntPtr hwndActive;
            public IntPtr hwndFocus;
            public IntPtr hwndCapture;
            public IntPtr hwndMenuOwner;
            public IntPtr hwndMoveSize;
            public IntPtr hwndCaret;
            public RECT rcCaret;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        private static string ClassNameOf(IntPtr hWnd)
        {
            var sb = new StringBuilder(256);
            try { GetClassName(hWnd, sb, sb.Capacity); } catch { }
            return sb.ToString();
        }

        /// <summary>类名是否属于「文本编辑框」家族。</summary>
        internal static bool IsEditClass(string cls)
        {
            if (string.IsNullOrEmpty(cls)) return false;
            // 经典编辑框：资源管理器重命名框、地址栏都是 Edit
            if (cls.Equals("Edit", StringComparison.OrdinalIgnoreCase)) return true;
            // 富文本编辑框：RichEdit / RichEdit20A / RichEdit20W / RichEdit50W / RichEditD2DPT …
            if (cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) return true;
            // 资源管理器搜索框、部分外壳控件
            if (cls.IndexOf("EditBox", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            // 第三方编辑器内核
            if (cls.Equals("Scintilla", StringComparison.OrdinalIgnoreCase)) return true;
            if (cls.StartsWith("TEdit", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>
        /// 当前前台窗口是否处于「正在输入文字」状态。
        /// 返回 true 时，空格必须放行给输入框和输入法，不能拿来开预览。
        /// </summary>
        public static bool IsTextEntryActive()
        {
            string reason;
            return IsTextEntryActive(out reason);
        }

        /// <summary>同上，额外给出判定依据（写日志用）。</summary>
        public static bool IsTextEntryActive(out string reason)
        {
            return IsTextEntryActiveFor(GetForegroundWindow(), out reason);
        }

        /// <summary>
        /// 指定窗口（通常是前台窗口）里是否正在输入文字。
        /// 单独暴露 hwnd 参数是为了让测试能直接对着一个自己造的编辑框断言，
        /// 不必要求它真的处于前台（那会抢用户焦点）。
        /// </summary>
        internal static bool IsTextEntryActiveFor(IntPtr fg, out string reason)
        {
            reason = null;
            try
            {
                if (fg == IntPtr.Zero) return false;

                uint tid = GetWindowThreadProcessId(fg, out _);
                IntPtr focus = IntPtr.Zero;
                var gui = new GUITHREADINFO();
                gui.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));

                // GetGUIThreadInfo 传目标窗口所属线程，拿到的就是该线程的焦点控件
                if (tid != 0 && GetGUIThreadInfo(tid, ref gui))
                    focus = gui.hwndFocus;

                // 焦点控件可能是 0（焦点就在顶层窗口上），退化为检查顶层窗口本身
                if (focus == IntPtr.Zero) focus = fg;

                string cls = ClassNameOf(focus);
                if (IsEditClass(cls))
                {
                    reason = "焦点在输入框（class=" + cls + "）";
                    return true;
                }

                // 兜底：不认识的类名但带可见光标，也按输入框处理
                bool caretVisible = gui.hwndCaret != IntPtr.Zero
                    && (gui.rcCaret.Right > gui.rcCaret.Left || gui.rcCaret.Bottom > gui.rcCaret.Top);
                if (caretVisible)
                {
                    reason = "焦点控件有可见光标（class=" + cls + "）";
                    return true;
                }

                return false;
            }
            catch
            {
                // 判断失败一律当作"没在输入"，宁可保持原有预览行为
                return false;
            }
        }
    }
}
