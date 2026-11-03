using System;
using System.IO;
using System.Security.Principal;
using System.Text.Json;
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

        /// <summary>本次是否"刚被更新后重新拉起"（setup.iss 装完会带 --updated 启动）。</summary>
        internal static bool StartedAfterUpdate;

        [STAThread]
        static void Main()
        {
            // 更新自检入口（排查/回归用）：不建托盘、不挂键盘钩子，跑完退出并写出 JSON 结果。
            // 必须放在单实例互斥体之前，否则主实例在跑时这里会被"已在运行"挡掉。
            if (HasFlag("--check-update"))
            {
                RunUpdateCheckCli();
                return;
            }

            // 无人值守更新（排查/回归用）：检查 → 下载 → 校验 → 静默安装 → 退出，
            // 由安装程序负责覆盖文件并重新拉起。正常用户走托盘/自动提示，不会用到这条。
            if (HasFlag("--update-now"))
            {
                RunUpdateNowCli();
                return;
            }

            StartedAfterUpdate = HasFlag("--updated");

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
            // 退出日志/互斥体释放仍由上面的 ApplicationExit 处理，这里不要重复做
            RunWithSelfHeal(ParsePreviewArg(), HasFlag("--quiet"));
        }

        /// <summary>
        /// 带自愈的消息循环。
        ///
        /// WebView2 在吃极端输入（用户实测：预览 1.9GB 的 mp4）时，会在原生窗口过程里抛
        /// SEHException，栈顶是 PInvoke.DispatchMessage。这种异常会**绕过**
        /// Application.ThreadException（WinForms 内层 catch 不吃它），一路冒到
        /// AppDomain.UnhandledException，而那个处理器只能记日志、拦不住进程退出。
        ///
        /// 结果就是用户说的「播放 mp4 直接崩溃」：预览窗口、托盘图标、全局空格键一起消失，
        /// 还得手动重新启动。现在在最外层接住，重建一个主窗体继续常驻，
        /// 用户最多看到一次气泡提示。10 分钟内最多重启 3 次，避免真的坏掉时死循环。
        /// </summary>
        private static void RunWithSelfHeal(string startupFile, bool quiet)
        {
            var restartAt = new System.Collections.Generic.List<DateTime>();
            bool first = true;

            while (true)
            {
                MainForm form = null;
                try
                {
                    // 构造也放进 try：WebView2 处于坏状态时，重建窗体本身就可能抛异常
                    form = new MainForm(first ? startupFile : null, quiet);
                    first = false;
                    Application.Run(form);
                    return;
                }
                catch (Exception ex)
                {
                    // 注意：这里不能只拦 SEHException。实测外部组件抛出的异常有时是
                    // ExternalException / COMException 形态，统一兜住更稳。
                    Log.E(LogKind.App, "预览引擎抛异常、主循环中断（SEHException/外部组件异常）", ex);

                    var now = DateTime.UtcNow;
                    restartAt.RemoveAll(t => (now - t).TotalMinutes > 10);
                    restartAt.Add(now);

                    if (restartAt.Count > 3)
                    {
                        Log.E(LogKind.App, "10 分钟内已连续恢复 " + (restartAt.Count - 1) + " 次，放弃自动重启");
                        throw;
                    }

                    try { if (form != null) form.Dispose(); } catch { }

                    try
                    {
                        // 原窗体已释放，用一个临时 NotifyIcon 播报；哪怕失败也不影响恢复
                        var ni = new NotifyIcon
                        {
                            Icon = System.Drawing.SystemIcons.Warning,
                            Visible = true,
                            Text = "QuickPreview"
                        };
                        ni.ShowBalloonTip(6000, "QuickPreview",
                            "预览引擎异常退出，已自动恢复。该文件可能不受支持，建议用默认程序打开。",
                            ToolTipIcon.Warning);
                        // 气泡显示 6 秒后回收，避免托盘里堆一排图标
                        var timer = new System.Windows.Forms.Timer { Interval = 8000 };
                        timer.Tick += (s, e2) => { try { timer.Stop(); timer.Dispose(); ni.Visible = false; ni.Dispose(); } catch { } };
                        timer.Start();
                    }
                    catch { }
                }
            }
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

        /// <summary>命令行里是否带某个开关（如 --quiet）。</summary>
        private static bool HasFlag(string flag)
        {
            try
            {
                foreach (var a in Environment.GetCommandLineArgs())
                    if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch { }
            return false;
        }

        /// <summary>
        /// 命令行检查更新（排查/回归用）：把结果写成 JSON 到 logs\update_check.json 供断言。
        /// 退出码：0 = 检查成功（有没有新版本都算成功），2 = 检查失败。
        /// </summary>
        private static void RunUpdateCheckCli()
        {
            int code = 2;
            try
            {
                Log.I(LogKind.Update, "==== CLI 检查更新（v" + AppVersion.Current + "）====");
                var r = UpdateService.CheckAsync(AppVersion.Current, CancellationToken.None)
                    .GetAwaiter().GetResult();

                var info = r.Info;
                var payload = new
                {
                    current = AppVersion.Current,
                    installed = UpdateService.IsInstalledCopy(),
                    ok = r.Ok,
                    newer = r.NewerAvailable,
                    message = r.Message,
                    version = info != null ? info.Version : "",
                    assetName = info != null ? info.AssetName : "",
                    assetUrl = info != null ? info.AssetUrl : "",
                    assetSize = info != null ? info.AssetSize : 0,
                    sha256 = info != null ? info.AssetSha256 : "",
                    htmlUrl = info != null ? info.HtmlUrl : ""
                };

                var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
                try
                {
                    Directory.CreateDirectory(Log.LogDir);
                    File.WriteAllText(Path.Combine(Log.LogDir, "update_check.json"), json);
                }
                catch (Exception ex)
                {
                    Log.W(LogKind.Update, "写更新结果文件失败：" + ex.Message);
                }

                Log.I(LogKind.Update, "CLI 检查结果：" + json.Replace("\r", " ").Replace("\n", " "));
                code = r.Ok ? 0 : 2;
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Update, "CLI 检查更新异常", ex);
            }
            finally
            {
                Log.Shutdown();
            }
            Environment.ExitCode = code;
        }

        /// <summary>
        /// 无人值守更新（排查/回归用）：检查 → 下载 → 校验 → 启动静默安装 → 退出。
        /// 安装程序会覆盖文件并带 --updated 重新拉起，所以本进程退出即是"交接点"。
        /// 结果写 logs\update_apply.json，退出码 0=已交接给安装程序 2=失败。
        /// </summary>
        private static void RunUpdateNowCli()
        {
            int code = 2;
            string stage = "check";
            string detail = "";
            try
            {
                Log.I(LogKind.Update, "==== CLI 执行更新（当前 v" + AppVersion.Current + "）====");

                var r = UpdateService.CheckAsync(AppVersion.Current, CancellationToken.None)
                    .GetAwaiter().GetResult();
                if (!r.Ok) throw new InvalidOperationException("检查更新失败：" + r.Message);
                if (!r.NewerAvailable)
                {
                    stage = "done";
                    detail = r.Message;
                    Log.I(LogKind.Update, "CLI 更新：没有新版本 —— " + r.Message);
                    WriteApplyResult(true, stage, detail);
                    code = 0;
                    return;
                }

                stage = "download";
                var path = UpdateService.DownloadAsync(r.Info, null, CancellationToken.None)
                    .GetAwaiter().GetResult();
                UpdateService.CleanupOldDownloads(path);

                stage = "install";
                // 先落结果文件再启动安装：安装程序 InitializeSetup 会 taskkill 本进程，
                // 若等到"启动完再写"，很可能写不进去（进程已被结束）。
                WriteApplyResult(true, stage, path);
                UpdateService.RunInstaller(path);
                code = 0;
                detail = path;
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Update, "CLI 更新失败（阶段：" + stage + "）", ex);
                detail = ex.Message;
                WriteApplyResult(false, stage, detail);
            }
            finally
            {
                Log.Shutdown();
            }
            Environment.ExitCode = code;
        }

        /// <summary>无人值守更新的结果文件，供回归脚本断言。</summary>
        private static void WriteApplyResult(bool ok, string stage, string detail)
        {
            try
            {
                var json = JsonSerializer.Serialize(new
                {
                    ok = ok,
                    stage = stage,
                    detail = detail,
                    current = AppVersion.Current
                }, new JsonSerializerOptions { WriteIndented = true });
                Directory.CreateDirectory(Log.LogDir);
                File.WriteAllText(Path.Combine(Log.LogDir, "update_apply.json"), json);
            }
            catch { }
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
