using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QuickPreview
{
    /// <summary>
    /// 预览服务主窗体：默认隐藏常驻托盘，监听全局空格键；
    /// 在文件资源管理器中选中文件按空格即显示预览浮层。
    /// </summary>
    public class MainForm : Form
    {
        // Web 预览引擎自身资源（webroot）的虚拟主机名
        private const string HostName = "app.local";

        // 本地文件服务的虚拟主机名。
        // 必须与 HostName 不同：app.local 已被 SetVirtualHostNameToFolderMapping 映射为 webroot 目录，
        // 同主机下的 /__local 请求会被该映射直接吞掉（返回 404），根本不会触发 WebResourceRequested，
        // 导致图片/文档全部读取失败。这里换成独立主机名，请求只由我们的过滤器响应。
        private const string FileHostName = "qpfile.local";
        private const string LocalPath = "/__local";

        // 经宿主对象直传（base64）给页面的文件大小上限，超过则回退到 __local 流式读取
        private const long MaxInlineBytes = 60L * 1024 * 1024;
        private const int VK_SPACE = 0x20;
        private const int HeartbeatMs = 30000;          // 心跳间隔（同时用于钩子存活检查）

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_SHOWWINDOW = 0x0040;

        // 用于「吞掉空格却没打开预览」时补发一次空格，避免用户操作被吃掉
        [DllImport("user32.dll", SetLastError = true)]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        private const byte VK_SPACE_B = 0x20;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        private enum TriggerResult
        {
            Opened,         // 已打开预览（按键吞掉即可）
            NoSelection,    // 没读到选中项 → 补发空格给用户
            NotSupported,   // 文件类型不支持（已提示）→ 吞掉即可
            Error           // 出错 → 补发空格
        }

        private NotifyIcon _tray;
        private WebView2 _web;
        private KeyboardHook _hook;
        private CoreWebView2 _core;
        private readonly System.Windows.Forms.Timer _heartbeat = new System.Windows.Forms.Timer { Interval = HeartbeatMs };
        private LogViewerForm _logViewer;
        private AboutForm _about;
        private int _heartbeatCount;

        private bool _coreReady;
        private bool _webInitStarted;     // WebView2 初始化已发起（防重复初始化）
        private bool _pageReady;          // 页面已加载并注册好宿主消息监听（由页面上报 ready）
        private bool _previewVisible;
        private bool _allowShow;              // 控制主窗体是否允许显示（启动时保持隐藏）
        private string _webRoot;
        private string _pendingPath;
        private List<string> _pendingSiblings = new List<string>();
        private IntPtr _lastExplorer = IntPtr.Zero;   // 触发预览时的前台窗口（关闭后把焦点还回去）
        private string _startupFile;                  // --preview 排查入口指定的文件
        private bool _previewActive;                  // 预览窗口当前是否处于激活（在前台）状态
        private string _currentPath;                  // 当前正在预览的文件（用于判断是切换还是重复预览）
        private bool _elevationWarned;                // 「读不到选中项 + 管理员级别」只提示一次，不反复打扰
        private readonly System.Windows.Forms.Timer _raiseTimer
            = new System.Windows.Forms.Timer { Interval = 300 };   // 置顶补偿定时器

        // ---------- 拖动 / 缩放预览窗口 ----------
        // 窗是无边框的（FormBorderStyle.None），没有系统标题栏可拖、也没有边框可拉，
        // 所以由前端在鼠标按下时上报方向（标题栏 / 左/右/上/下/四角），
        // 这里用 16ms 定时器跟随 Cursor.Position 实时改 Bounds。
        // 之所以在宿主侧轮询而不是让前端发坐标：鼠标移出窗口后前端事件会断，
        // 用 Cursor.Position 才不会"拖到一半卡住"。
        private const int HT_CAPTION = 2;
        private const int HT_LEFT = 10, HT_RIGHT = 11, HT_TOP = 12, HT_TOPLEFT = 13,
                          HT_TOPRIGHT = 14, HT_BOTTOM = 15, HT_BOTTOMLEFT = 16, HT_BOTTOMRIGHT = 17;

        private readonly System.Windows.Forms.Timer _dragTimer
            = new System.Windows.Forms.Timer { Interval = 16 };
        private bool _dragActive;
        private int _dragEdge;
        private Point _dragOrigin;
        private Rectangle _dragBounds;

        // 允许通过 __local 读取的本地文件（当前预览文件 + 同目录可预览文件 + 转码产物）
        private readonly HashSet<string> _allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        /// <param name="startupFile">排查用：启动后直接预览该文件（--preview 参数），正常为 null</param>
        public MainForm(string startupFile = null)
        {
            _startupFile = startupFile;
            Text = "QuickPreview";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            // 位置/大小取用户上次调整过的值；没有记录或已不在任何屏幕上则用默认（居中 1040x720）
            Bounds = AppConfig.LoadWindowBounds() ?? AppConfig.DefaultWindowBounds();
            MinimumSize = new Size(AppConfig.MinimumWidth, AppConfig.MinimumHeight);
            BackColor = Color.FromArgb(30, 30, 30);
            ShowInTaskbar = false;
            TopMost = true;

            // 拖动 / 缩放：无边框窗体没有系统标题栏与边框，只能由前端上报"按住"，
            // 再由这里按鼠标当前位置实时改 Bounds（见 BeginWindowDrag）
            _dragTimer.Tick += OnDragTick;

            _webRoot = Path.Combine(AppContext.BaseDirectory, "webroot");

            Log.I(LogKind.App, "主窗体初始化，webroot=" + _webRoot
                + "（存在：" + Directory.Exists(_webRoot) + "）");
            if (Directory.Exists(_webRoot))
            {
                try { Log.I(LogKind.App, "webroot 文件数：" + Directory.GetFiles(_webRoot, "*", SearchOption.AllDirectories).Length); }
                catch { }
            }
            else
            {
                Log.E(LogKind.App, "webroot 不存在，预览引擎无法加载！");
            }

            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);

            // WebView2 需要宿主窗口句柄；主窗体常驻隐藏，这里主动创建句柄，避免初始化失败
            try { if (!IsHandleCreated) { var h = Handle; } }
            catch (Exception ex) { Log.E(LogKind.App, "创建窗口句柄失败", ex); }

            // 记录预览窗口的激活状态：用于判断"空格＝关闭"还是"空格＝切换到新选中项"
            Activated += (s, e) => { _previewActive = true; };
            Deactivate += (s, e) => { _previewActive = false; };

            // 有些场景下资源管理器会在我们弹出后立刻把 z 序抢回去，这里做一次补偿置顶
            _raiseTimer.Tick += (s, e) =>
            {
                _raiseTimer.Stop();
                if (_previewVisible && Visible) ForceToFront();
            };

            // WebView2 初始化是最耗时的一步（冷启动可达数秒），必须最先开始；
            // 否则用户在它就绪前按空格，会多等一大截才看到内容。
            _ = InitWebViewAsync();

            InitTray();
            InitHook();
            InitHeartbeat();

            // 注意：这里**只在日志里记一笔，不弹气泡**。
            // 早期版本启动即弹「当前以管理员权限运行，无法读取选中文件」，但这是误报：
            // 机器上关掉 UAC 时（企业镜像、个人手动关掉都很常见），双击启动拿到的就是
            // 完全管理员令牌，而此时资源管理器同样是管理员级别 —— 两边同级别，
            // COM 调用完全正常，用户实测能正常预览，却被无端吓了一跳。
            // 真正的判据不是「自己是不是管理员」，而是「读选中项是否真的失败」，
            // 所以提示改到读取失败的分支里（见 TriggerPreviewFromExplorer）。
            if (Program.IsElevated)
                Log.W(LogKind.App, "当前进程处于管理员完整性级别；若读取选中项失败，会提示切回普通权限");
        }

        // ---------- 图标 ----------
        public static Icon AppIcon()
        {
            try
            {
                string ico = Path.Combine(AppContext.BaseDirectory, "QuickPreview.ico");
                if (File.Exists(ico)) return new Icon(ico);
                var own = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (own != null) return own;
            }
            catch { }
            return SystemIcons.Application;
        }

        // ---------- 隐藏主窗体 ----------
        protected override void SetVisibleCore(bool value)
        {
            base.SetVisibleCore(_allowShow && value);
        }

        // ---------- 托盘 ----------
        private void InitTray()
        {
            _tray = new NotifyIcon
            {
                Icon = AppIcon(),
                Text = "QuickPreview — 资源管理器中选中文件后按空格预览",
                Visible = true
            };

            var menu = new ContextMenuStrip();
            menu.Items.Add("预览当前选中的文件（空格）", null, (s, e) => TriggerPreviewFromExplorer());
            menu.Items.Add(new ToolStripSeparator());

            var auto = new ToolStripMenuItem("开机自动启动") { Checked = Autostart.IsEnabled() };
            auto.Click += (s, e) =>
            {
                auto.Checked = !auto.Checked;
                Autostart.Set(auto.Checked, Application.ExecutablePath);
                Log.I(LogKind.App, "开机自启设置为：" + auto.Checked);
            };
            menu.Items.Add(auto);

            menu.Items.Add("清除转码缓存", null, (s, e) =>
            {
                try { Directory.Delete(MediaTranscode.CacheDir, true); Log.I(LogKind.Media, "已清除转码缓存"); }
                catch (Exception ex) { Log.W(LogKind.Media, "清除转码缓存失败：" + ex.Message); }
            });

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("关于 QuickPreview…", null, (s, e) => ShowAbout());
            menu.Items.Add("查看日志…", null, (s, e) => ShowLogViewer());
            menu.Items.Add("打开日志目录", null, (s, e) =>
            {
                Log.FlushAll();
                LogViewerForm.OpenDir(Log.LogDir);
            });
            // 以管理员运行时读取选中项必然失败，提供一键自愈：降级到普通权限重启
            if (Program.IsElevated)
            {
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("以普通权限重启（修复按空格无反应）", null, (s, e) =>
                {
                    Log.I(LogKind.App, "托盘菜单：以普通权限重启");
                    try
                    {
                        // 经 explorer.exe 启动自身，进程会继承资源管理器的普通完整性级别
                        Process.Start(new ProcessStartInfo("explorer.exe",
                            "\"" + Application.ExecutablePath + "\"") { UseShellExecute = true });
                        Log.I(LogKind.App, "已请求以普通权限重启，本实例退出");
                    }
                    catch (Exception ex)
                    {
                        Log.E(LogKind.App, "以普通权限重启失败", ex);
                    }

                    _tray.Visible = false;
                    Log.Shutdown();
                    Application.Exit();
                });
            }

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (s, e) =>
            {
                Log.I(LogKind.App, "托盘菜单：退出");
                _tray.Visible = false;
                Log.Shutdown();
                Application.Exit();
            });

            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (s, e) => TriggerPreviewFromExplorer();
            Log.I(LogKind.App, "托盘图标已就绪");
        }

        private void ShowAbout()
        {
            try
            {
                if (_about == null || _about.IsDisposed) _about = new AboutForm();
                // 托盘菜单弹出时没有前台窗口，需显式置顶 + 激活，否则窗口会躲在后面
                _about.TopMost = true;
                _about.Show();
                _about.BringToFront();
                _about.Activate();
                Log.I(LogKind.App, "托盘菜单：关于（版本 " + AppVersion.Current + "）");
            }
            catch (Exception ex)
            {
                Log.E(LogKind.App, "打开关于窗口失败", ex);
            }
        }

        private void ShowLogViewer()
        {
            try
            {
                if (_logViewer == null || _logViewer.IsDisposed) _logViewer = new LogViewerForm();
                _logViewer.Show();
                _logViewer.BringToFront();
                _logViewer.Activate();
            }
            catch (Exception ex)
            {
                Log.E(LogKind.App, "打开日志窗口失败", ex);
            }
        }

        // ---------- 全局空格键 ----------
        private void InitHook()
        {
            _hook = new KeyboardHook();
            _hook.KeyDown += OnSpaceKey;
            _hook.Start();
        }

        private void InitHeartbeat()
        {
            _heartbeat.Tick += (s, e) =>
            {
                _heartbeatCount++;
                try
                {
                    if (_hook != null && !_hook.Installed)
                    {
                        Log.W(LogKind.Hook, "检测到钩子已失效（可能被系统移除），尝试重新安装");
                        _hook.Start();
                    }
                }
                catch { }

                if (_heartbeatCount % 10 == 0)   // 每 5 分钟记录一次存活状态
                {
                    Log.I(LogKind.App, string.Format(
                        "心跳：服务运行中 | 钩子={0} | WebView2={1} | 预览窗口={2} | 内存={3:N0} KB",
                        _hook != null && _hook.Installed ? "正常" : "未安装",
                        _coreReady ? "就绪" : "未就绪",
                        _previewVisible ? "显示中" : "隐藏",
                        Environment.WorkingSet / 1024));
                }
            };
            _heartbeat.Start();
        }

        /// <summary>
        /// 键盘钩子回调（运行在 Windows 的「输入同步调用」上下文中）。
        /// 关键约束：此回调内**禁止**任何跨进程 COM 调用（Shell.Application 等），
        /// 否则必然抛 RPC_E_CANTCALLOUT_ININPUTSYNCCALL。
        /// 因此这里只做零成本的 Win32 判断，随后吞键 + 投递到 UI 线程异步处理。
        /// </summary>
        private bool OnSpaceKey(int vk)
        {
            if (vk != VK_SPACE) return false;          // 只关心空格，其它键一律放行

            try
            {
                if (_previewVisible)
                {
                    // 预览窗口仍在前台（用户正看着它）→ 空格＝关闭，与 Quick Look 一致
                    if (_previewActive)
                    {
                        Log.I(LogKind.Hook, "捕获空格键（预览在前台）→ 关闭预览");
                        BeginInvoke(new Action(() =>
                        {
                            try { HidePreview(); }
                            catch (Exception ex) { Log.E(LogKind.Hook, "异步关闭预览失败", ex); }
                        }));
                        return true;
                    }

                    // 预览已不在前台：说明用户回到了资源管理器（可能换了目录/换了文件），
                    // 此时空格应当是"关掉旧的、打开新选中的"，而不是单纯关闭。
                    IntPtr fg2 = GetForegroundWindow();
                    string cls2 = ExplorerSelection.ClassNameOf(fg2);
                    if (!ExplorerSelection.IsCandidateClass(cls2))
                    {
                        Log.D(LogKind.Hook, "空格放行（预览已失焦）：前台 class=" + cls2 + " 不是文件窗口");
                        return false;
                    }

                    Log.I(LogKind.Hook, "捕获空格键（预览已失焦，前台 class=" + cls2 + "）→ 关闭旧预览并切换到当前选中项");
                    BeginInvoke(new Action(() => HandleSpaceAsync(fg2)));
                    return true;
                }

                // 廉价前置判断（仅 Win32，无 COM）：不是文件窗口就直接放行，不影响其它软件打字
                IntPtr fg = GetForegroundWindow();
                string cls = ExplorerSelection.ClassNameOf(fg);
                if (!ExplorerSelection.IsCandidateClass(cls))
                {
                    Log.D(LogKind.Hook, "空格放行：前台窗口 class=" + cls + " 不是文件窗口");
                    return false;
                }

                Log.I(LogKind.Hook, "捕获空格键（前台 class=" + cls + "）→ 投递异步任务读取选中项");
                BeginInvoke(new Action(() => HandleSpaceAsync(fg)));
                return true;                            // 先吞掉，避免资源管理器收到空格
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Hook, "处理空格键异常", ex);
                return false;
            }
        }

        /// <summary>
        /// 异步处理空格（已在 UI 线程、已脱离输入同步调用上下文，可以安全调用 COM）。
        /// </summary>
        private void HandleSpaceAsync(IntPtr fg)
        {
            var sw = Stopwatch.StartNew();
            TriggerResult r;
            try
            {
                r = TriggerPreviewFromExplorer(fg);
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Hook, "异步处理空格异常", ex);
                r = TriggerResult.Error;
            }

            Log.I(LogKind.Hook, "空格触发结果：" + r + "，耗时 " + sw.ElapsedMilliseconds + "ms");

            // 吞了键却没打开预览 → 补发一次空格，保证用户在资源管理器里的操作不被吃掉
            if (r == TriggerResult.NoSelection || r == TriggerResult.Error)
            {
                Log.W(LogKind.Hook, "未能打开预览，补发空格键给原窗口");
                SendSpace();
            }
        }

        private void SendSpace()
        {
            try
            {
                keybd_event(VK_SPACE_B, 0, 0, UIntPtr.Zero);
                keybd_event(VK_SPACE_B, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
            catch (Exception ex)
            {
                Log.W(LogKind.Hook, "补发空格失败：" + ex.Message);
            }
        }

        public bool TriggerPreviewFromExplorer()
        {
            return TriggerPreviewFromExplorer(GetForegroundWindow()) == TriggerResult.Opened;
        }

        private TriggerResult TriggerPreviewFromExplorer(IntPtr fg)
        {
            try
            {
                _lastExplorer = fg;

                var sel = ExplorerSelection.GetForegroundSelection();

                // 关键：桌面（Progman）的 SelectedItems 会把回收站、此电脑这类
                // 虚拟项一起返回，且常常排在真实文件前面（实测顺序就是「回收站, 我的文档」）。
                // 之前直接取 sel[0] 判定为"虚拟项不支持"就整个放弃了 —— 这正是
                // 「桌面按空格没反应」的根因。这里先过滤掉虚拟项，再取第一个真实路径。
                int virtualCount = 0;
                for (int i = sel.Count - 1; i >= 0; i--)
                {
                    if (string.IsNullOrEmpty(sel[i]) || sel[i].StartsWith("::")) { sel.RemoveAt(i); virtualCount++; }
                }
                if (virtualCount > 0)
                    Log.D(LogKind.Hook, "已过滤桌面虚拟项 " + virtualCount + " 个（回收站/此电脑等，路径形如 ::{GUID}）");

                if (sel.Count == 0)
                {
                    string cls = ExplorerSelection.ClassNameOf(fg);
                    Log.W(LogKind.Hook, "未读取到任何选中项，放弃预览（前台窗口 class=" + cls + "）");

                    // 只有「焦点确实在资源管理器、却读不到选中项」时才可能是权限问题。
                    // 注意判据：不是"我是管理员就一定是权限问题"（UAC 关闭时两边都是管理员，
                    // 完全正常），而是"读不到 + 我处于高完整性级别"才提示，且只提示一次。
                    bool explorerFg = cls == "CabinetWClass" || cls == "ExploreWClass";
                    if (explorerFg && Program.IsElevated && !_elevationWarned)
                    {
                        _elevationWarned = true;
                        Log.W(LogKind.Hook, "焦点在资源管理器但读不到选中项，且本程序处于管理员级别："
                            + "很可能是与资源管理器完整性级别不一致");
                        try
                        {
                            _tray.ShowBalloonTip(10000, "QuickPreview 读取不到选中文件",
                                "当前程序以管理员权限运行，与普通权限的资源管理器不在同一级别，"
                                + "无法读取选中项。可从托盘菜单选「以普通权限重启」。", ToolTipIcon.Warning);
                        }
                        catch { }
                    }
                    else if (explorerFg)
                    {
                        Log.W(LogKind.Hook, "已确认焦点在资源管理器但仍读不到选中项，"
                            + "请检查该窗口里是否真的选中了文件（或选中项位于另一个标签页）");
                    }
                    return TriggerResult.NoSelection;
                }

                var first = sel[0];

                // 兜底：过滤后理论上不会再有虚拟项，留着防止漏网
                if (first.StartsWith("::"))
                {
                    Log.W(LogKind.Hook, "选中项是虚拟项（非文件系统路径），不支持预览：" + first);
                    return TriggerResult.NotSupported;
                }

                bool isDir = Directory.Exists(first);

                if (!isDir && !File.Exists(first))
                {
                    Log.W(LogKind.Hook, "选中项不是文件/文件夹或不存在：" + first);
                    return TriggerResult.NoSelection;
                }

                // 文件夹走独立的"文件夹信息"预览；文件仍需是可预览类型
                if (!isDir && !FileTypes.IsPreviewable(first))
                {
                    Log.W(LogKind.Preview, "不支持预览该类型：" + first);
                    _tray.ShowBalloonTip(4000, "QuickPreview",
                        "暂不支持预览该文件类型：" + Path.GetExtension(first), ToolTipIcon.Info);
                    return TriggerResult.NotSupported;
                }

                ShowPreview(first, isDir ? new List<string>() : SiblingsOf(first, sel));
                return TriggerResult.Opened;
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Hook, "触发预览失败", ex);
                return TriggerResult.Error;
            }
        }

        // 多选时按选择顺序翻页；单选时按同目录可预览文件翻页
        private List<string> SiblingsOf(string path, List<string> selection)
        {
            var list = new List<string>();

            if (selection != null && selection.Count > 1)
            {
                foreach (var p in selection)
                    if (File.Exists(p)) list.Add(p);
                return list;
            }

            try
            {
                var dir = Path.GetDirectoryName(path);
                if (string.IsNullOrEmpty(dir)) return list;
                var files = Directory.GetFiles(dir);
                Array.Sort(files, StringComparer.OrdinalIgnoreCase);
                foreach (var f in files)
                    if (FileTypes.IsPreviewable(f)) list.Add(f);
            }
            catch { }

            return list;
        }

        // ---------- 显示 / 隐藏预览 ----------
        public void ShowPreview(string path, List<string> siblings)
        {
            _allowed.Clear();
            _allowed.Add(path);
            if (siblings != null)
                foreach (var s in siblings) _allowed.Add(s);

            // 已在预览中：切到别的文件 → 先让页面停掉上一次渲染，再打开新的（避免串文件）
            bool switching = _previewVisible
                && !string.Equals(_currentPath, path, StringComparison.OrdinalIgnoreCase);

            Log.I(LogKind.Preview, string.Format("{0}：{1}（类型 {2}，可翻页文件 {3} 个，WebView2 {4}）",
                switching ? "切换预览" : "显示预览",
                path, FileTypes.CategoryOf(path), siblings != null ? siblings.Count : 0,
                _coreReady ? "就绪" : "未就绪"));

            _currentPath = path;

            // 先把窗口抬起来（即使 WebView2 还没就绪，也要给用户"有反应"的反馈）
            _previewVisible = true;
            _allowShow = true;
            if (!Visible) Show();
            ForceToFront();
            _raiseTimer.Stop();
            _raiseTimer.Start();       // 300ms 后再补一次，防止资源管理器抢回 z 序

            if (switching && _coreReady)
            {
                // 关键：通知页面丢弃上一次的渲染任务（PDF 逐页渲染不会自己停，会一直翻页）
                try { _core.PostWebMessageAsJson("{\"type\":\"close\"}"); }
                catch (Exception ex) { Log.W(LogKind.Preview, "通知页面关闭旧预览失败：" + ex.Message); }
            }

            // WebView2 就绪 ≠ 页面已就绪：页面 JS 解析初始化还需要时间，
            // 过早下发 open 会被丢弃（表现为"窗口弹出来了但内容空白"），故一并排队。
            if (!_coreReady || !_pageReady)
            {
                _pendingPath = path;
                _pendingSiblings = siblings ?? new List<string>();
                Log.W(LogKind.Preview, "页面尚未就绪（coreReady=" + _coreReady + "，pageReady=" + _pageReady
                    + "），预览请求已排队等待");
                return;
            }

            SendOpen(path, siblings);
        }

        /// <summary>
        /// 把预览窗口可靠地推到最前。
        /// 只调 BringToFront/Activate 不够：我们不是前台进程，Windows 的"防抢焦点"会把
        /// 新弹窗插到当前前台窗口（资源管理器）后面，表现为"预览窗口躲在文件夹背后"。
        /// 这里用 AttachThreadInput + HWND_TOPMOST + SetForegroundWindow 组合拳，
        /// 并把结果写日志，便于实机排查。
        /// </summary>
        private void ForceToFront()
        {
            try
            {
                if (!IsHandleCreated) return;

                TopMost = true;

                IntPtr fg = GetForegroundWindow();
                uint tidFg = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
                uint tidMe = GetCurrentThreadId();

                bool attached = false;
                if (tidFg != 0 && tidFg != tidMe)
                    attached = AttachThreadInput(tidMe, tidFg, true);

                SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                bool ok = SetForegroundWindow(Handle);

                if (attached) AttachThreadInput(tidMe, tidFg, false);

                Activate();
                BringToFront();
                _previewActive = true;

                IntPtr now = GetForegroundWindow();
                Log.D(LogKind.Preview, string.Format("置顶：SetForegroundWindow={0}，置顶后前台为本窗口={1}",
                    ok, now == Handle));
            }
            catch (Exception ex)
            {
                Log.W(LogKind.Preview, "置顶预览窗口失败：" + ex.Message);
            }
        }

        private void SendOpen(string path, List<string> siblings)
        {
            // items 附带大小与「是否文件夹」，页面据此决定是渲染内容还是文件夹信息面板
            // （只靠扩展名无法区分无扩展名的文件夹）。
            var pathList = new List<string>();
            if (siblings != null)
                foreach (var s in siblings)
                    if (s != null && !pathList.Contains(s)) pathList.Add(s);
            if (!pathList.Contains(path)) pathList.Insert(0, path);

            var items = new List<object>();
            foreach (var p in pathList) items.Add(MakeItem(p));

            // 当前文件默认由哪个程序打开（"Word"/"Excel"/"照片"/"记事本"…），
            // 页面用它把按钮文案改成「使用 Word 打开」。
            string app = ShellAssoc.FriendlyAppName(path);

            var json = JsonSerializer.Serialize(new
            {
                type = "open",
                path = path,
                siblings = siblings ?? new List<string>(),
                items = items,
                currentApp = app
            });

            _core.PostWebMessageAsJson(json);
            Log.D(LogKind.Web, "→ web: open " + path + "（" + items.Count + " 项，默认程序=" + (app ?? "未知") + "）");
        }

        // ---------- 窗口拖动 / 缩放 ----------

        /// <summary>开始拖动或缩放（edge 取 HT_* 常量）。</summary>
        private void BeginWindowDrag(int edge)
        {
            _dragEdge = edge;
            _dragOrigin = Cursor.Position;
            _dragBounds = Bounds;
            _dragActive = true;
            _dragTimer.Start();
            Log.D(LogKind.App, "开始" + (edge == HT_CAPTION ? "移动" : "缩放")
                + "预览窗口（起始 " + _dragBounds + "）");
        }

        private void OnDragTick(object sender, EventArgs e)
        {
            if (!_dragActive) return;

            // 兜底：拖动过程中前端的 pointerup 可能因为指针移出 WebView2 而收不到，
            // 这里检测物理左键已松开就直接结束，避免窗口"粘"在鼠标上。
            if ((Control.MouseButtons & MouseButtons.Left) == 0)
            {
                EndWindowDrag();
                return;
            }

            Point p = Cursor.Position;
            int dx = p.X - _dragOrigin.X;
            int dy = p.Y - _dragOrigin.Y;
            Rectangle b = _dragBounds;

            if (_dragEdge == HT_CAPTION)
            {
                b = new Rectangle(b.X + dx, b.Y + dy, b.Width, b.Height);
                // 不允许把窗口整块拖出屏幕：至少留 80px 宽 / 40px 高的标题栏可见，
                // 否则用户再也点不到、只能删配置文件
                var wa = Screen.FromPoint(p).WorkingArea;
                if (b.Right < wa.Left + 80) b.X = wa.Left + 80 - b.Width;
                if (b.Left > wa.Right - 80) b.X = wa.Right - 80;
                if (b.Bottom < wa.Top + 40) b.Y = wa.Top + 40 - b.Height;
                if (b.Top > wa.Bottom - 40) b.Y = wa.Bottom - 40;
            }
            else
            {
                int left = b.Left, top = b.Top, right = b.Right, bottom = b.Bottom;
                if (_dragEdge == HT_LEFT || _dragEdge == HT_TOPLEFT || _dragEdge == HT_BOTTOMLEFT) left += dx;
                if (_dragEdge == HT_RIGHT || _dragEdge == HT_TOPRIGHT || _dragEdge == HT_BOTTOMRIGHT) right += dx;
                if (_dragEdge == HT_TOP || _dragEdge == HT_TOPLEFT || _dragEdge == HT_TOPRIGHT) top += dy;
                if (_dragEdge == HT_BOTTOM || _dragEdge == HT_BOTTOMLEFT || _dragEdge == HT_BOTTOMRIGHT) bottom += dy;

                // 最小尺寸保护：拖过头时保持最小宽高，不让窗口塌陷成一条线
                if (right - left < AppConfig.MinimumWidth)
                {
                    if (left != b.Left) left = right - AppConfig.MinimumWidth;
                    else right = left + AppConfig.MinimumWidth;
                }
                if (bottom - top < AppConfig.MinimumHeight)
                {
                    if (top != b.Top) top = bottom - AppConfig.MinimumHeight;
                    else bottom = top + AppConfig.MinimumHeight;
                }
                b = Rectangle.FromLTRB(left, top, right, bottom);
            }

            if (!b.Equals(Bounds)) Bounds = b;
        }

        private void EndWindowDrag()
        {
            if (!_dragActive) return;
            _dragActive = false;
            _dragTimer.Stop();
            AppConfig.SaveWindowBounds(Bounds);
            Log.I(LogKind.App, "预览窗口位置/大小已保存：" + Bounds);
        }

        private static object MakeItem(string path)
        {
            string name;
            try { name = Path.GetFileName(path.TrimEnd('\\')); }
            catch { name = path; }
            if (string.IsNullOrEmpty(name)) name = path;

            bool dir = false;
            long size = 0;
            try
            {
                if (Directory.Exists(path)) dir = true;
                else size = new FileInfo(path).Length;
            }
            catch { }

            return new { path = path, name = name, size = size, dir = dir };
        }

        public void HidePreview()
        {
            _raiseTimer.Stop();
            _previewVisible = false;
            _previewActive = false;
            _currentPath = null;
            Hide();
            Log.I(LogKind.Preview, "关闭预览窗口");

            if (_coreReady)
            {
                try { _core.PostWebMessageAsJson("{\"type\":\"close\"}"); } catch { }
            }

            // 把焦点还给触发预览的窗口（与 Quick Look 行为一致，方便继续操作文件）
            if (_lastExplorer != IntPtr.Zero)
            {
                try { SetForegroundWindow(_lastExplorer); } catch { }
                _lastExplorer = IntPtr.Zero;
            }
        }

        // ---------- WebView2 初始化 ----------
        private async System.Threading.Tasks.Task InitWebViewAsync()
        {
            // 幂等保护：重复初始化会创建两套 CoreWebView2，页面 ready 上报两次、
            // 预览指令被错误地消费，表现为"窗口弹出来了但一直没有内容"。
            if (_webInitStarted) return;
            _webInitStarted = true;

            try
            {
                if (!Directory.Exists(_webRoot))
                {
                    Log.E(LogKind.Web, "webroot 不存在：" + _webRoot);
                    _tray.ShowBalloonTip(6000, "QuickPreview",
                        "未找到 webroot（请先执行 npm run build:web）", ToolTipIcon.Error);
                    return;
                }

                Log.I(LogKind.Web, "开始初始化 WebView2 …");
                var sw = Stopwatch.StartNew();

                // WebView2 的用户数据目录（缓存 / GPUCache / Cookies / leveldb）默认生成在
                // exe 同目录下（<exe名>.WebView2）。这会带来两个问题：
                //   1) 安装目录被塞进几十 MB 无关文件；升级安装时 Inno 只覆盖同名的文件，
                //      旧版本遗留的缓存不会被删除，目录会从 ~230MB 一路膨胀到 300MB+；
                //   2) 卸载程序只清理自己安装的文件，这份缓存永远留在用户的安装目录里。
                // 因此显式指到 %LOCALAPPDATA%\QuickPreview\WebView2——该目录已由安装脚本的
                // [UninstallDelete] 覆盖，卸载时会连同日志、配置一起清干净。
                // 必须在 EnsureCoreWebView2Async 之前设置，否则会抛 InvalidOperationException。
                try
                {
                    var udf = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "QuickPreview", "WebView2");
                    Directory.CreateDirectory(udf);
                    var cp = new CoreWebView2CreationProperties { UserDataFolder = udf };

                    // 音视频"打开即播"：Chromium 默认要求用户手势才允许有声自动播放，
                    // 否则 play() 被静默拒绝（表现为点了没反应、要手动点播放键）。
                    // 这里放开策略 —— 预览窗口本来就是用户按空格主动打开的。
                    string browserArgs = "--autoplay-policy=no-user-gesture-required";

                    // 开发/自动化测试钩子：给 WebView2 加 --remote-debugging-port，
                    // 这样 test-samples 里的脚本可以直接驱动页面（点按钮、量尺寸、截图），
                    // 不必依赖鼠标模拟（本机安全策略禁止 PowerShell COM 操作窗口）。
                    // 只有显式设置了环境变量才生效，正常使用不受影响。
                    var cdpPort = Environment.GetEnvironmentVariable("QP_DEV_CDP_PORT");
                    if (!string.IsNullOrWhiteSpace(cdpPort))
                    {
                        browserArgs += " --remote-debugging-port=" + cdpPort.Trim();
                        Log.W(LogKind.Web, "【开发模式】已开启远程调试端口 " + cdpPort.Trim()
                            + "（仅 QP_DEV_CDP_PORT 环境变量存在时生效）");
                    }

                    cp.AdditionalBrowserArguments = browserArgs;
                    _web.CreationProperties = cp;
                    Log.I(LogKind.Web, "WebView2 用户数据目录：" + udf);
                }
                catch (Exception ex)
                {
                    // 设置失败不致命，回退到默认位置（exe 同目录）仍然能正常预览
                    Log.W(LogKind.Web, "设置 WebView2 用户数据目录失败，使用默认位置：" + ex.Message);
                }

                await _web.EnsureCoreWebView2Async();
                _core = _web.CoreWebView2;
                Log.I(LogKind.Web, "WebView2 就绪，耗时 " + sw.ElapsedMilliseconds + "ms"
                    + "（运行时版本：" + (_core.Environment != null ? _core.Environment.BrowserVersionString : "未知") + "）");

                // 把本地 webroot 映射为虚拟主机，页面以 https://app.local/ 加载
                _core.SetVirtualHostNameToFolderMapping(HostName, _webRoot,
                    CoreWebView2HostResourceAccessKind.Allow);

                // 宿主对象：window.QP.prepareMediaAsync(path) → Promise
                _core.AddHostObjectToScript("QP", new QPBridge(this));

                // 拦截 __local 请求，用于读取任意本地文件（含 Range，供音视频拖动）
                _core.AddWebResourceRequestedFilter($"https://{FileHostName}{LocalPath}*",
                    CoreWebView2WebResourceContext.All);
                _core.WebResourceRequested += OnWebResourceRequested;

                // JS → C#
                _core.WebMessageReceived += OnWebMessageReceived;

                // 渲染进程崩溃/无响应：以前完全没有监听，出问题时只表现为
                // 「预览窗口白屏、页面像卡死」，日志里一个字都没有。
                _core.ProcessFailed += (s2, e2) =>
                {
                    // GPU / 解码这类子进程崩了 Chromium 会自动重启，且无显卡的机器（远程桌面、
                    // 虚拟机）上必然反复崩，记成 ERROR 会把问题日志彻底淹没 —— 只有浏览器主进程
                    // 或渲染进程退出才是真的"预览没了"，那才用 ERROR。
                    bool fatal = e2.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited
                              || e2.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited;
                    string info = "Web 子进程异常：" + e2.ProcessFailedKind
                        + "（reason=" + e2.Reason + "，exitCode=" + e2.ExitCode + "）"
                        + (fatal ? " —— 本次预览已中断" : "（非致命，Chromium 会自动重启该进程）");
                    if (fatal) Log.E(LogKind.Web, info);
                    else Log.W(LogKind.Web, info);
                };
                _web.CoreWebView2InitializationCompleted += (s, e) =>
                {
                    if (!e.IsSuccess) Log.E(LogKind.Web, "WebView2 初始化失败：" + e.InitializationException);
                };

                _coreReady = true;
                _web.Source = new Uri($"https://{HostName}/index.html");
                Log.I(LogKind.Web, "预览引擎已加载：https://" + HostName + "/index.html");

                if (!string.IsNullOrEmpty(_pendingPath))
                {
                    var p = _pendingPath;
                    var s = _pendingSiblings;
                    _pendingPath = null;
                    SendOpen(p, s);
                }
                else if (!string.IsNullOrEmpty(_startupFile))
                {
                    // --preview 排查入口：直接预览指定文件，无需在资源管理器按空格
                    var f = _startupFile;
                    _startupFile = null;
                    var sibs = new List<string>();
                    bool isDir = Directory.Exists(f);
                    try
                    {
                        // 文件夹本身没有"同目录兄弟"，翻页列表留空
                        if (!isDir)
                        {
                            var dir = Path.GetDirectoryName(f);
                            foreach (var x in Directory.GetFiles(dir))
                                if (FileTypes.IsPreviewable(x)) sibs.Add(x);
                        }
                    }
                    catch { }
                    Log.I(LogKind.App, "--preview 直接预览：" + f + (isDir ? "（文件夹）" : "（同目录可翻页 " + sibs.Count + " 个）"));
                    ShowPreview(f, sibs);
                }
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Web, "WebView2 初始化失败（请确认已安装 WebView2 Evergreen Runtime）", ex);
                _tray.ShowBalloonTip(8000, "QuickPreview", "WebView2 初始化失败：" + ex.Message, ToolTipIcon.Error);
            }
        }

        // ---------- 本地文件服务（含 Range） ----------
        private void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                var uri = new Uri(e.Request.Uri);
                var p = QueryParam(uri, "p");

                // 入口日志：若这条都没出现，说明过滤器没匹配上（主机名/路径与 webroot 映射冲突）
                Log.I(LogKind.Media, "← __local 请求：" + e.Request.Uri);

                if (string.IsNullOrEmpty(p) || !File.Exists(p))
                {
                    Log.W(LogKind.Media, "404 本地文件不存在：" + p);
                    Respond(e, 404, "Not Found", (byte[])null, "Content-Type: text/plain");
                    return;
                }
                if (!_allowed.Contains(p))
                {
                    Log.W(LogKind.Media, "403 不在允许列表：" + p);
                    Respond(e, 403, "Forbidden", (byte[])null, "Content-Type: text/plain");
                    return;
                }

                // 关键：绝不 ReadAllBytes。
                // 以前这里一次性把整个文件读进内存，预览大视频时播放器会连发多个 Range 请求，
                // 每个请求全量读 + 复制一份 chunk，内存瞬间翻几倍，进程直接 OOM 退出
                // （用户看到的就是「加载大视频后点关闭就崩溃」）。现在只按区间流式读取。
                long total = new FileInfo(p).Length;
                string mime = FileTypes.MimeOf(p);

                string range = null;
                try { range = e.Request.Headers.GetHeader("Range"); } catch { }

                long start = 0;
                long end = total - 1;
                int status = 200;
                string reason = "OK";
                string contentRange = null;

                if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes="))
                {
                    string spec = range.Substring(6);
                    // 多区间（逗号分隔）极少见，只取第一段
                    int comma = spec.IndexOf(',');
                    if (comma >= 0) spec = spec.Substring(0, comma);

                    var parts = spec.Split('-');
                    string a = parts.Length > 0 ? parts[0].Trim() : string.Empty;
                    string b = parts.Length > 1 ? parts[1].Trim() : string.Empty;

                    long parsed;
                    if (a.Length == 0)
                    {
                        // bytes=-N → 最后 N 字节
                        long suffix;
                        if (long.TryParse(b, out suffix) && suffix > 0)
                            start = Math.Max(0, total - suffix);
                        end = total - 1;
                    }
                    else
                    {
                        if (long.TryParse(a, out parsed)) start = parsed;
                        if (b.Length > 0)
                        {
                            if (long.TryParse(b, out parsed)) end = parsed;
                        }
                        else end = total - 1;
                    }

                    if (total <= 0)
                    {
                        start = 0; end = 0;
                    }
                    else
                    {
                        if (start < 0) start = 0;
                        if (end >= total) end = total - 1;
                        if (start >= total) start = total - 1;
                        if (end < start) end = start;
                    }

                    status = 206;
                    reason = "Partial Content";
                    contentRange = $"bytes {start}-{end}/{total}";
                }
                else if (total <= 0)
                {
                    end = -1;
                }

                var headers = new StringBuilder();
                headers.Append($"Content-Type: {mime}").Append("\r\n");
                headers.Append("Accept-Ranges: bytes").Append("\r\n");
                headers.Append("Access-Control-Allow-Origin: *").Append("\r\n");
                if (contentRange != null)
                    headers.Append($"Content-Range: {contentRange}").Append("\r\n");

                long len = Math.Max(0, end - start + 1);
                Log.D(LogKind.Media, string.Format("__local {0} {1}：{2}，{3:N0} 字节（{4:N0}–{5:N0} / 共 {6:N0}），mime={7}",
                    status, Path.GetFileName(p), reason, len, start, end, total, mime));

                FileStream fs = null;
                try
                {
                    fs = new FileStream(p, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.SequentialScan);
                    if (start > 0) fs.Seek(start, SeekOrigin.Begin);
                    Respond(e, status, reason, new ByteRangeStream(fs, len), headers.ToString());
                    fs = null;   // 所有权已交给响应流，由它在读完/释放时关闭
                }
                finally
                {
                    if (fs != null) { try { fs.Dispose(); } catch { } }
                }
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Media, "处理 __local 请求异常", ex);
                try { Respond(e, 500, "Internal Error", (byte[])null, "Content-Type: text/plain"); } catch { }
            }
        }

        private void Respond(CoreWebView2WebResourceRequestedEventArgs e, int status, string reason,
            byte[] body, string headers)
        {
            Respond(e, status, reason, new MemoryStream(body ?? new byte[0]), headers);
        }

        private void Respond(CoreWebView2WebResourceRequestedEventArgs e, int status, string reason,
            Stream body, string headers)
        {
            e.Response = _core.Environment.CreateWebResourceResponse(
                body, status, reason, (headers ?? string.Empty) + "\r\n");
        }

        private static string QueryParam(Uri uri, string key)
        {
            var q = uri.Query;
            if (string.IsNullOrEmpty(q)) return null;
            if (q[0] == '?') q = q.Substring(1);

            foreach (var kv in q.Split('&'))
            {
                int i = kv.IndexOf('=');
                if (i <= 0) continue;
                if (kv.Substring(0, i) == key)
                    return Uri.UnescapeDataString(kv.Substring(i + 1).Replace("+", " "));
            }
            return null;
        }

        // ---------- JS → C# ----------
        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var json = e.WebMessageAsJson;
                Log.D(LogKind.Web, "← web: " + (json.Length > 300 ? json.Substring(0, 300) + "…" : json));

                using (var doc = JsonDocument.Parse(json))
                {
                    var root = doc.RootElement;

                    // 页面用 postMessage(JSON.stringify(obj)) 发送字符串时，
                    // WebView2 会再做一次 JSON 编码，这里拿到的是「JSON 字符串」而非对象。
                    // 不处理会导致 TryGetProperty 抛异常，页面上报的错误被全部吞掉。
                    JsonDocument inner = null;
                    if (root.ValueKind == JsonValueKind.String)
                    {
                        var s = root.GetString();
                        if (!string.IsNullOrWhiteSpace(s) && s.TrimStart().StartsWith("{"))
                        {
                            try { inner = JsonDocument.Parse(s); root = inner.RootElement; }
                            catch { /* 不是对象型 JSON，按原样处理 */ }
                        }
                    }

                    using (inner)
                    {
                        HandleWebMessage(root);
                    }
                }
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Web, "处理网页消息异常", ex);
            }
        }

        private void HandleWebMessage(JsonElement root)
        {
            try
            {
                if (root.ValueKind != JsonValueKind.Object) return;
                if (!root.TryGetProperty("type", out var t)) return;

                    var type = t.GetString();
                    if (type == "requestClose") HidePreview();
                    else if (type == "openExternal" && root.TryGetProperty("path", out var oep))
                        OpenWithDefaultApp(oep.GetString());
                    else if (type == "showInFolder" && root.TryGetProperty("path", out var p))
                        ShowInFolder(p.GetString());
                    else if (type == "log" && root.TryGetProperty("message", out var m))
                        Log.I(LogKind.Web, "[页面] " + m.GetString());
                    else if (type == "windowDrag")
                    {
                        // 前端在标题栏/边框上按下鼠标时上报，edge 用 HT_* 数值
                        int edge = HT_CAPTION;
                        if (root.TryGetProperty("edge", out var eg)) eg.TryGetInt32(out edge);
                        BeginWindowDrag(edge);
                    }
                    else if (type == "windowDragEnd")
                        EndWindowDrag();
                    else if (type == "resetWindowBounds")
                    {
                        // 用户把窗口搞乱了（比如换了小屏）时的兜底：恢复默认位置与大小
                        Bounds = AppConfig.DefaultWindowBounds();
                        AppConfig.SaveWindowBounds(Bounds);
                        Log.I(LogKind.App, "预览窗口已恢复默认位置/大小：" + Bounds);
                    }
                    else if (type == "readFile" && root.TryGetProperty("path", out var rfp))
                    {
                        int id = 0;
                        if (root.TryGetProperty("id", out var rfid)) rfid.TryGetInt32(out id);
                        var path = rfp.GetString();

                        // 回退通道：页面 __local 读取失败时，改为由宿主直接把文件内容回传
                        _ = HandleReadFileAsync(id, path);
                    }
                    else if (type == "prepareMedia" && root.TryGetProperty("path", out var pmp))
                    {
                        int id = 0;
                        if (root.TryGetProperty("id", out var pmid)) pmid.TryGetInt32(out id);

                        // 媒体准备（含 ape/mkv 等格式的 ffmpeg 转码）走与 readFile 同一条
                        // 消息往返通道：宿主对象方法 QP.prepareMediaAsync 在部分环境会因
                        // COM 参数封送失败报 0x80070057（E_INVALIDARG），导致音视频全部预览失败。
                        _ = HandlePrepareMediaAsync(id, pmp.GetString());
                    }
                    else if (type == "folderStat" && root.TryGetProperty("path", out var fsp))
                    {
                        int id = 0;
                        if (root.TryGetProperty("id", out var fsid)) fsid.TryGetInt32(out id);
                        if (_allowed.Contains(fsp.GetString()))
                            _ = HandleFolderStatAsync(id, fsp.GetString());
                        else
                            Log.W(LogKind.Web, "拒绝统计未授权路径：" + fsp.GetString());
                    }
                    else if (type == "ready")
                    {
                        _pageReady = true;
                        Log.I(LogKind.Web, "[页面] 预览引擎就绪");

                        // 补发排队中的预览请求（程序刚启动后的第一次预览走这条路径）
                        if (!string.IsNullOrEmpty(_pendingPath))
                        {
                            var rp = _pendingPath;
                            var rs = _pendingSiblings;
                            _pendingPath = null;
                            SendOpen(rp, rs);
                        }

                    }
                    else if (type == "error" && root.TryGetProperty("message", out var em))
                        Log.E(LogKind.Web, "[页面异常] " + em.GetString());
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Web, "处理网页消息异常", ex);
            }
        }

        /// <summary>
        /// 处理页面的 readFile 请求：读取文件并以 fileData 消息回传 base64。
        /// 这是 __local 通道失效时的兜底，不经 HTTP 拦截。
        /// </summary>
        private async System.Threading.Tasks.Task HandleReadFileAsync(int id, string path)
        {
            string json;
            try { json = await ReadFileAsync(path).ConfigureAwait(false); }
            catch (Exception ex) { json = JsonSerializer.Serialize(new { ok = false, error = ex.Message }); }

            try
            {
                using (var d = JsonDocument.Parse(json))
                {
                    var r = d.RootElement;
                    bool ok = r.TryGetProperty("ok", out var o) && o.GetBoolean();
                    string b64 = r.TryGetProperty("base64", out var b) ? b.GetString() : null;
                    string err = r.TryGetProperty("error", out var e2) ? e2.GetString() : null;

                    var payload = JsonSerializer.Serialize(new
                    {
                        type = "fileData",
                        id = id,
                        ok = ok,
                        base64 = b64,
                        error = err
                    });

                    if (_coreReady && _core != null)
                    {
                        _core.PostWebMessageAsJson(payload);
                        Log.D(LogKind.Media, string.Format("直传回传：{0}（{1}）", Path.GetFileName(path),
                            ok ? (b64 != null ? b64.Length + " 字符 base64" : "无数据") : "失败：" + err));
                    }
                }
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Web, "回传文件数据失败", ex);
            }
        }

        /// <summary>
        /// 处理页面的 prepareMedia 请求：必要时转码，并以 mediaReady 消息回传可播放地址。
        /// 与 readFile 同一条消息往返通道，绕开宿主对象方法调用的 0x80070057 问题。
        /// </summary>
        private async System.Threading.Tasks.Task HandlePrepareMediaAsync(int id, string path)
        {
            Log.I(LogKind.Media, "请求媒体资源：" + path);
            var sw = Stopwatch.StartNew();

            MediaResult r;
            try { r = await MediaTranscode.PrepareAsync(path).ConfigureAwait(false); }
            catch (Exception ex)
            {
                Log.E(LogKind.Media, "媒体准备异常：" + path, ex);
                PostMediaReady(id, path, false, null, null, ex.Message);
                return;
            }

            if (r == null || !r.ok)
            {
                string err = r != null ? r.error : "未知错误";
                Log.E(LogKind.Media, "媒体准备失败：" + path + " → " + err);
                PostMediaReady(id, path, false, null, null, err);
                return;
            }

            Log.I(LogKind.Media, "媒体就绪（" + sw.ElapsedMilliseconds + "ms）："
                + (r.path == path ? "直接播放" : "转码产物") + " → " + r.mime);

            PostMediaReady(id, path, true, r.path, r.mime, null);
        }

        /// <summary>
        /// 文件夹统计（后台线程执行，可能耗时数秒）。
        /// </summary>
        private async System.Threading.Tasks.Task HandleFolderStatAsync(int id, string path)
        {
            FolderStatResult r;
            try
            {
                r = await System.Threading.Tasks.Task.Run(() => FolderStats.Stat(path))
                                                     .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                r = new FolderStatResult { ok = false, error = ex.Message };
            }

            var payload = JsonSerializer.Serialize(new
            {
                type = "folderStatResult",
                id = id,
                ok = r.ok,
                error = r.error,
                path = r.path,
                size = r.size,
                files = r.files,
                dirs = r.dirs,
                truncated = r.truncated,
                elapsedMs = r.elapsedMs,
                created = r.created.ToString("yyyy-MM-dd HH:mm"),
                modified = r.modified.ToString("yyyy-MM-dd HH:mm"),
                entries = r.entries.Select(e => new
                {
                    name = e.name,
                    size = e.size,
                    dir = e.dir,
                    modified = e.modified.ToString("yyyy-MM-dd HH:mm")
                })
            });

            // CoreWebView2 成员只能在 UI 线程访问
            BeginInvoke(new Action(() =>
            {
                try
                {
                    if (_coreReady && _core != null)
                        _core.PostWebMessageAsJson(payload);
                }
                catch (Exception ex)
                {
                    Log.E(LogKind.Web, "回传文件夹统计失败", ex);
                }
            }));
        }

        /// <summary>
        /// 回传媒体就绪消息。
        /// 转码在后台线程完成，而 CoreWebView2 只允许 UI 线程访问，
        /// 因此这里统一切回 UI 线程再登记白名单并投递消息。
        /// </summary>
        private void PostMediaReady(int id, string srcPath, bool ok, string playPath,
                                    string mime, string error)
        {
            Action post = () =>
            {
                string url = null;
                if (ok && !string.IsNullOrEmpty(playPath))
                {
                    _allowed.Add(playPath);
                    url = $"https://{FileHostName}{LocalPath}?p=" + Uri.EscapeDataString(playPath);
                }

                try
                {
                    var payload = JsonSerializer.Serialize(new
                    {
                        type = "mediaReady",
                        id = id,
                        ok = ok,
                        url = url,
                        mime = mime,
                        error = error
                    });

                    if (_coreReady && _core != null)
                    {
                        _core.PostWebMessageAsJson(payload);
                        Log.D(LogKind.Media, string.Format("媒体就绪回传：{0} → {1}",
                            Path.GetFileName(srcPath), ok ? url : "失败：" + error));
                    }
                }
                catch (Exception ex) { Log.E(LogKind.Web, "回传媒体数据失败", ex); }
            };

            try
            {
                if (InvokeRequired) BeginInvoke(post);
                else post();
            }
            catch (Exception ex) { Log.E(LogKind.Web, "投递媒体回传失败", ex); }
        }

        // ---------- 供 window.QP 调用 ----------

        /// <summary>
        /// 直接把本地文件内容（base64）交给页面，用于图片 / 文本 / PDF / 办公文档。
        /// 不经过 WebResourceRequested，因此不受虚拟主机映射影响，是预览内容的主通道。
        /// </summary>
        public System.Threading.Tasks.Task<string> ReadFileAsync(string path)
        {
            return System.Threading.Tasks.Task.Run(() =>
            {
                try
                {
                    if (string.IsNullOrEmpty(path) || !File.Exists(path))
                        return JsonSerializer.Serialize(new { ok = false, error = "文件不存在：" + path });

                    if (!_allowed.Contains(path))
                    {
                        // 预览目标由资源管理器选中项决定，此处补登记，避免路径大小写差异导致误拒
                        _allowed.Add(path);
                    }

                    var bytes = File.ReadAllBytes(path);
                    if (bytes.LongLength > MaxInlineBytes)
                        return JsonSerializer.Serialize(new
                        {
                            ok = false,
                            tooLarge = true,
                            size = bytes.LongLength,
                            error = "文件过大（" + bytes.LongLength + " 字节），不走直传通道"
                        });

                    Log.D(LogKind.Media, string.Format("直传文件：{0}（{1:N0} 字节，mime={2}）",
                        Path.GetFileName(path), bytes.LongLength, FileTypes.MimeOf(path)));

                    return JsonSerializer.Serialize(new
                    {
                        ok = true,
                        base64 = Convert.ToBase64String(bytes),
                        size = bytes.LongLength,
                        mime = FileTypes.MimeOf(path)
                    });
                }
                catch (Exception ex)
                {
                    Log.E(LogKind.Media, "直传文件失败：" + path, ex);
                    return JsonSerializer.Serialize(new { ok = false, error = ex.Message });
                }
            });
        }

        public async System.Threading.Tasks.Task<string> PrepareMediaAsync(string path)
        {
            Log.I(LogKind.Media, "请求媒体资源：" + path);
            var sw = Stopwatch.StartNew();

            var r = await MediaTranscode.PrepareAsync(path).ConfigureAwait(false);

            if (!r.ok)
            {
                Log.E(LogKind.Media, "媒体准备失败：" + path + " → " + r.error);
                return JsonSerializer.Serialize(new { ok = false, error = r.error });
            }

            _allowed.Add(r.path);
            var url = $"https://{FileHostName}{LocalPath}?p=" + Uri.EscapeDataString(r.path);
            Log.I(LogKind.Media, "媒体就绪（" + sw.ElapsedMilliseconds + "ms）：" + (r.path == path ? "直接播放" : "转码产物")
                + " → " + r.mime);
            return JsonSerializer.Serialize(new { ok = true, url = url, mime = r.mime });
        }

        public void ShowInFolder(string path)
        {
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"")
                {
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                Log.W(LogKind.Preview, "在文件夹中显示失败：" + ex.Message);
            }
        }

        /// <summary>
        /// 用系统默认程序打开当前预览的文件/文件夹，并立即关闭预览浮层
        /// （用户点「用默认程序打开」时的预期是：预览消失、目标程序出现在前台）。
        /// </summary>
        private void OpenWithDefaultApp(string path)
        {
            if (string.IsNullOrEmpty(path))
                return;

            Log.I(LogKind.Preview, "用默认程序打开：" + path);

            // 先关预览并交还焦点，避免新启动的程序窗口被置顶的预览浮层挡住
            HidePreview();

            try
            {
                bool isDir;
                try { isDir = Directory.Exists(path); } catch { isDir = false; }

                if (isDir)
                    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + path + "\"")
                    { UseShellExecute = true });
                else
                    Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Preview, "用默认程序打开失败：" + path, ex);
                try
                {
                    _tray.ShowBalloonTip(5000, "QuickPreview",
                        "无法用默认程序打开该文件：" + ex.Message, ToolTipIcon.Warning);
                }
                catch { }
            }
        }

        // ---------- 清理 ----------
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { _heartbeat.Stop(); _heartbeat.Dispose(); } catch { }
                try { _hook?.Stop(); } catch { }
                try { if (_logViewer != null && !_logViewer.IsDisposed) _logViewer.Dispose(); } catch { }
                try { if (_about != null && !_about.IsDisposed) _about.Dispose(); } catch { }
                try { if (_tray != null) { _tray.Visible = false; _tray.Dispose(); } } catch { }
            }
            base.Dispose(disposing);
        }
    }
}
