using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace QuickPreview
{
    /// <summary>按下某键时触发；返回 true 表示吞掉该按键（不再传给其它程序），false 表示放行。</summary>
    public delegate bool KeyboardHandler(int vk);

    /// <summary>全局低层键盘钩子（WH_KEYBOARD_LL）。</summary>
    public class KeyboardHook
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;

        private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        private readonly HookProc _proc;
        private IntPtr _hookId = IntPtr.Zero;

        public event KeyboardHandler KeyDown;

        /// <summary>钩子是否已成功安装。</summary>
        public bool Installed => _hookId != IntPtr.Zero;

        public KeyboardHook()
        {
            _proc = HookCallback;
        }

        public void Start()
        {
            if (_hookId != IntPtr.Zero) return;
            try
            {
                using (var cur = Process.GetCurrentProcess())
                using (var mod = cur.MainModule)
                {
                    _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(mod.ModuleName), 0);
                }

                if (_hookId == IntPtr.Zero)
                    Log.E(LogKind.Hook, "安装全局键盘钩子失败，Win32 错误码：" + Marshal.GetLastWin32Error());
                else
                    Log.I(LogKind.Hook, "全局键盘钩子已安装，handle=" + _hookId.ToInt64());
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Hook, "安装全局键盘钩子异常", ex);
            }
        }

        public void Stop()
        {
            if (_hookId == IntPtr.Zero) return;
            UnhookWindowsHookEx(_hookId);
            Log.I(LogKind.Hook, "全局键盘钩子已卸载");
            _hookId = IntPtr.Zero;
        }

        private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
                {
                    int vk = Marshal.ReadInt32(lParam);
                    var handler = KeyDown;
                    if (handler != null)
                    {
                        bool swallow;
                        try { swallow = handler(vk); }
                        catch (Exception ex)
                        {
                            Log.E(LogKind.Hook, "按键处理回调异常 vk=" + vk, ex);
                            swallow = false;
                        }
                        // 返回非零即拦截该按键，不再传递给目标窗口
                        if (swallow) return (IntPtr)1;
                    }
                }
            }
            return CallNextHookEx(_hookId, nCode, wParam, lParam);
        }
    }
}
