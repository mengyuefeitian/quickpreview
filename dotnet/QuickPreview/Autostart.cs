using Microsoft.Win32;

namespace QuickPreview
{
    /// <summary>开机自启：写入 HKCU Run 项（无需管理员权限）。</summary>
    public static class Autostart
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AppName = "QuickPreview";

        public static bool IsEnabled()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey, false))
                {
                    return key?.GetValue(AppName) != null;
                }
            }
            catch
            {
                return false;
            }
        }

        public static void Set(bool enable, string exePath)
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey, true))
                {
                    if (key == null) return;
                    if (enable) key.SetValue(AppName, $"\"{exePath}\"");
                    else key.DeleteValue(AppName, false);
                }
            }
            catch { }
        }
    }
}
