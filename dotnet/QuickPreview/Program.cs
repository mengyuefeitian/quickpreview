using System;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

namespace QuickPreview
{
    internal static class Program
    {
        /// <summary>
        /// 单实例互斥体。名称同时用于安装包（Inno Setup 的 AppMutex）识别并关闭正在运行的实例，
        /// 改名时必须同步 dotnet\setup.iss。
        /// </summary>
        internal const string SingleInstanceMutex = "QuickPreview_SingleInstance_Mutex";

        private static Mutex _mutex;

        /// <summary>当前进程是否以管理员（高完整性级别）运行。</summary>
        internal static bool IsElevated;

        [STAThread]
        static void Main()
        {
            bool createdNew;
            _mutex = new Mutex(true, SingleInstanceMutex, out createdNew);
            if (!createdNew)
            {
                // 已有实例在运行：直接退出，避免重复挂钩导致空格被处理两次
                MessageBox.Show("QuickPreview 已在运行，请查看系统托盘图标。",
                    "QuickPreview", MessageBoxButtons.OK, MessageBoxIcon.Information);
                _mutex.Dispose();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 全局异常兜底：任何未捕获异常都进日志，避免"静默失败"
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                Log.E(LogKind.App, "未处理异常（进程级）", e.ExceptionObject as Exception);
                Log.Shutdown();
            };
            Application.ThreadException += (s, e) =>
                Log.E(LogKind.App, "未处理异常（UI 线程）", e.Exception);
            Application.ApplicationExit += (s, e) =>
            {
                Log.I(LogKind.App, "==== QuickPreview 退出 ====");
                Log.Shutdown();
                try { _mutex?.ReleaseMutex(); _mutex?.Dispose(); } catch { }
                _mutex = null;
            };

            LogStartup();

            // 后台常驻：主窗体默认隐藏，由托盘 + 全局空格键驱动
            Application.Run(new MainForm(ParsePreviewArg()));
        }

        /// <summary>
        /// 排查用入口：QuickPreview.exe --preview "文件绝对路径"
        /// 无需在资源管理器里按空格即可直接拉起预览窗口，便于验证渲染链路。
        /// </summary>
        private static string ParsePreviewArg()
        {
            try
            {
                var args = Environment.GetCommandLineArgs();
                for (int i = 1; i < args.Length; i++)
                {
                    if ((args[i] == "--preview" || args[i] == "-p") && i + 1 < args.Length)
                    {
                        var p = args[i + 1].Trim('"');
                        // 支持文件夹：便于直接预览文件夹信息（含大小统计）
                        if (System.IO.File.Exists(p) || System.IO.Directory.Exists(p)) return p;
                        Log.W(LogKind.App, "--preview 指定的文件不存在：" + p);
                    }
                }
            }
            catch (Exception ex)
            {
                Log.W(LogKind.App, "解析命令行参数失败：" + ex.Message);
            }
            return null;
        }

        private static void LogStartup()
        {
            Log.I(LogKind.App, "================================================================");
            Log.I(LogKind.App, "==== QuickPreview 启动 v" + AppVersion.Current + " ====");
            Log.I(LogKind.App, "程序目录：" + AppContext.BaseDirectory);
            Log.I(LogKind.App, "日志目录：" + Log.LogDir);
            Log.I(LogKind.App, "系统：" + Environment.OSVersion + " | 64位进程：" + Environment.Is64BitProcess
                + " | 用户：" + Environment.UserDomainName + "\\" + Environment.UserName);
            Log.I(LogKind.App, ".NET 运行时：" + Environment.Version);

            try
            {
                using (var id = WindowsIdentity.GetCurrent())
                {
                    var p = new WindowsPrincipal(id);
                    IsElevated = p.IsInRole(WindowsBuiltInRole.Administrator);

                    if (IsElevated)
                        // 关键：以管理员运行时与资源管理器处于不同完整性级别，
                        // 跨 UIPI 边界读取 Shell 选中项会被拒绝（E_ACCESSDENIED），表现为"按空格没反应"。
                        Log.E(LogKind.App, "当前【以管理员权限运行】！资源管理器通常是普通权限，"
                            + "两者权限级别不一致会导致读取选中项被系统拒绝（E_ACCESSDENIED），"
                            + "表现为按空格无反应。请以普通权限重新启动本程序。");
                    else
                        Log.I(LogKind.App, "权限级别：普通用户（与资源管理器一致，可正常读取选中项）");
                }
            }
            catch (Exception ex)
            {
                Log.W(LogKind.App, "无法判断权限：" + ex.Message);
            }

            try
            {
                Log.I(LogKind.App, "ffmpeg：" + (System.IO.File.Exists(MediaTranscode.FfmpegPath)
                    ? "已就位 " + MediaTranscode.FfmpegPath
                    : "缺失（ape/mkv 等格式将无法转码） → " + MediaTranscode.FfmpegPath));
            }
            catch (Exception ex)
            {
                Log.W(LogKind.App, "检查 ffmpeg 失败：" + ex.Message);
            }
        }
    }
}
