using System;
using System.Drawing;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace QuickPreview
{
    /// <summary>
    /// 「检查更新 / 发现新版本」窗口。
    ///
    /// 两种打开方式：
    ///   1) 托盘菜单「检查更新…」→ 先开窗、窗内显示"正在检查"，查完在同一窗口展示结果
    ///      （不用 MessageBox，避免"点了没反应"的空窗期）；
    ///   2) 后台定时检查发现新版本 → 直接展示更新内容，不激活窗口（不抢用户键盘焦点）。
    ///
    /// 下载与安装都在这里收口：下载带进度与速度、可取消；校验通过才启动安装程序，
    /// 然后回调宿主退出进程（安装程序会负责覆盖文件并重新拉起）。
    /// </summary>
    public class UpdateForm : Form
    {
        private readonly bool _checkOnOpen;          // 打开后先联网检查（手动模式）
        private readonly Action _onExitForInstall;   // 安装程序已启动 → 让宿主退出
        private UpdateInfo _info;
        private bool _noActivate;                    // 自动提示：显示但不抢焦点

        private CancellationTokenSource _cts;
        private bool _downloading;
        private bool _installable;                   // 能否一键静默安装（安装版 + 有资产）
        private bool _closedForInstall;

        private Label _title;
        private Label _subtitle;
        private TextBox _notes;
        private LinkLabel _link;
        private Label _status;
        private ProgressBar _bar;
        private Button _btnPrimary;
        private Button _btnLater;
        private Button _btnSkip;
        private Button _btnClose;

        /// <summary>手动检查模式：开窗即开始检查。</summary>
        public UpdateForm(Action onExitForInstall)
            : this(null, onExitForInstall)
        {
            _checkOnOpen = true;
        }

        /// <summary>直接展示某个已查到的新版本。</summary>
        public UpdateForm(UpdateInfo info, Action onExitForInstall)
        {
            _info = info;
            _onExitForInstall = onExitForInstall;
            BuildUi();
        }

        // 自动提示不抢焦点：用户可能正在别的程序里打字，弹窗抢焦点会打断输入。
        protected override bool ShowWithoutActivation { get { return _noActivate; } }

        /// <summary>正在下载/安装。此时外部不要再重建窗口，否则会把下载打断。</summary>
        public bool IsBusy { get { return _downloading; } }

        /// <summary>显示窗口。activate=false 时只浮在最上层，不抢焦点。</summary>
        public void ShowUpdateWindow(bool activate)
        {
            _noActivate = !activate;
            try
            {
                TopMost = true;
                Show();
                if (activate)
                {
                    BringToFront();
                    Activate();
                }
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Update, "显示更新窗口失败", ex);
            }
        }

        // ---------- 界面 ----------
        private void BuildUi()
        {
            Text = "QuickPreview 更新";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei", 9f);
            ClientSize = new Size(560, 450);
            BackColor = Color.White;
            try { Icon = MainForm.AppIcon(); } catch { }

            var iconBox = new PictureBox
            {
                Location = new Point(24, 22),
                Size = new Size(48, 48),
                SizeMode = PictureBoxSizeMode.StretchImage,
                Image = ToBitmap(MainForm.AppIcon())
            };

            _title = new Label
            {
                Text = "发现新版本",
                Font = new Font("Microsoft YaHei", 14f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 30, 30),
                Location = new Point(86, 24),
                AutoSize = true
            };

            _subtitle = new Label
            {
                Text = "",
                Font = new Font("Microsoft YaHei", 9f),
                ForeColor = Color.FromArgb(110, 110, 110),
                Location = new Point(88, 56),
                AutoSize = true
            };

            var notesLabel = new Label
            {
                Text = "更新内容",
                ForeColor = Color.FromArgb(60, 60, 60),
                Location = new Point(24, 88),
                AutoSize = true
            };

            _notes = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BorderStyle = BorderStyle.FixedSingle,
                Location = new Point(24, 110),
                Size = new Size(512, 176),
                BackColor = Color.FromArgb(248, 248, 248),
                ForeColor = Color.FromArgb(50, 50, 50),
                // 显式指定字体：不设的话 TextBox 用系统默认的小号字体，
                // 中文更新说明挤成一团，读起来很费劲
                Font = new Font("Microsoft YaHei", 9f),
                Text = ""
            };

            _link = new LinkLabel
            {
                Text = "在浏览器中查看发布页面",
                Location = new Point(24, 292),
                AutoSize = true,
                LinkColor = Color.FromArgb(0, 102, 204),
                VisitedLinkColor = Color.FromArgb(0, 102, 204)
            };
            _link.LinkClicked += (s, e) => OpenReleasesPage();

            _status = new Label
            {
                Text = "",
                Location = new Point(24, 316),
                Size = new Size(512, 20),
                ForeColor = Color.FromArgb(90, 90, 90)
            };

            _bar = new ProgressBar
            {
                Location = new Point(24, 340),
                Size = new Size(512, 14),
                Style = ProgressBarStyle.Continuous,
                Minimum = 0,
                Maximum = 1000,
                Value = 0
            };

            _btnPrimary = new Button
            {
                Text = "立即更新",
                Location = new Point(104, 396),
                Size = new Size(144, 34),
                Enabled = false,
                // 不给键盘焦点：本程序的核心操作就是空格，用户很可能在更新窗口开着时
                // 顺手按空格去预览文件；若这个按钮正持有焦点，一次空格就会开始下载并静默安装。
                // TabStop=false 之后只能靠鼠标点，误触概率降到零。
                TabStop = false
            };
            _btnPrimary.Click += OnPrimaryClick;

            _btnLater = new Button
            {
                Text = "稍后提醒",
                Location = new Point(256, 396),
                Size = new Size(92, 34),
                Visible = false
            };
            _btnLater.Click += (s, e) =>
            {
                AppConfig.SnoozeUpdate(24);
                Log.I(LogKind.Update, "更新：用户选择稍后提醒（24 小时）");
                Close();
            };

            _btnSkip = new Button
            {
                Text = "跳过此版",
                Location = new Point(356, 396),
                Size = new Size(92, 34),
                Visible = false
            };
            _btnSkip.Click += (s, e) =>
            {
                if (_info != null) AppConfig.SkipUpdateVersion(_info.Version);
                Log.I(LogKind.Update, "更新：用户跳过版本 " + (_info != null ? _info.Version : ""));
                Close();
            };

            _btnClose = new Button
            {
                Text = "关闭",
                Location = new Point(456, 396),
                Size = new Size(80, 34)
            };
            _btnClose.Click += (s, e) =>
            {
                // 下载中点关闭＝取消下载，不留半截文件
                try { if (_cts != null) _cts.Cancel(); } catch { }
                Close();
            };

            Controls.Add(iconBox);
            Controls.Add(_title);
            Controls.Add(_subtitle);
            Controls.Add(notesLabel);
            Controls.Add(_notes);
            Controls.Add(_link);
            Controls.Add(_status);
            Controls.Add(_bar);
            Controls.Add(_btnPrimary);
            Controls.Add(_btnLater);
            Controls.Add(_btnSkip);
            Controls.Add(_btnClose);

            CancelButton = _btnClose;
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            if (_checkOnOpen) SetCheckingState();
            else if (_info != null) ShowInfo(_info);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);

            // 自动弹出时不抢焦点，也不让任何按钮成为"当前控件"：
            // 用户此刻多半正在资源管理器里按空格预览文件，焦点留在原地最安全。
            if (_noActivate)
            {
                try { ActiveControl = null; } catch { }
            }

            if (_checkOnOpen) _ = RunCheckAsync();
        }

        // ---------- 状态切换 ----------
        private void SetCheckingState()
        {
            _title.Text = "正在检查更新";
            _subtitle.Text = "当前版本 v" + AppVersion.Current;
            _notes.Text = "";
            _status.Text = "正在连接 GitHub…";
            _bar.Style = ProgressBarStyle.Marquee;
            _bar.MarqueeAnimationSpeed = 30;
            _btnPrimary.Enabled = false;
            _btnPrimary.Text = "立即更新";
            _btnLater.Visible = false;
            _btnSkip.Visible = false;
            _btnClose.Enabled = true;
        }

        private void SetLatestState(string message)
        {
            _title.Text = "已是最新版本";
            _subtitle.Text = "当前版本 v" + AppVersion.Current;
            _notes.Text = "无需更新，关闭本窗口即可。";
            _status.Text = message;
            _status.ForeColor = Color.FromArgb(70, 130, 80);
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 1000;
            _btnPrimary.Enabled = false;
            _btnPrimary.Text = "立即更新";
            _btnLater.Visible = false;
            _btnSkip.Visible = false;
        }

        private void SetErrorState(string message)
        {
            _title.Text = "检查更新失败";
            _subtitle.Text = "当前版本 v" + AppVersion.Current;
            _notes.Text = "常见原因：网络不通、公司代理拦截、或 GitHub 接口限流（每小时 60 次）。\r\n"
                + "稍后重试即可；也可以点下面的链接手动查看发布页。";
            _status.Text = message;
            _status.ForeColor = Color.FromArgb(176, 60, 60);
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 0;
            _btnPrimary.Enabled = false;
            _btnPrimary.Text = "立即更新";
            _btnLater.Visible = false;
            _btnSkip.Visible = false;
        }

        private void ShowInfo(UpdateInfo info)
        {
            if (info == null) return;

            _title.Text = "发现新版本 v" + info.Version;
            var date = info.PublishedAtUtc == DateTime.MinValue
                ? ""
                : " · 发布于 " + info.PublishedAtUtc.ToLocalTime().ToString("yyyy-MM-dd");
            _subtitle.Text = "当前版本 v" + AppVersion.Current + date;
            _notes.Text = SanitizeNotes(info.Notes);
            _notes.SelectionStart = 0;
            _notes.SelectionLength = 0;
            _status.ForeColor = Color.FromArgb(90, 90, 90);
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 0;

            _installable = info.HasAsset && UpdateService.IsInstalledCopy();

            if (!info.HasAsset)
            {
                _status.Text = "该版本没有可直接安装的安装包，请用发布页面下载。";
                _btnPrimary.Text = "打开下载页";
                _btnPrimary.Enabled = true;
            }
            else if (!UpdateService.IsInstalledCopy())
            {
                // 便携版：不能静默覆盖自己，老实引导到发布页
                _status.Text = "当前是便携版运行，一键更新仅对安装版可用。";
                _btnPrimary.Text = "打开下载页";
                _btnPrimary.Enabled = true;
                Log.W(LogKind.Update, "更新：当前不在安装目录（" + AppContext.BaseDirectory
                    + "），改为打开下载页");
            }
            else
            {
                _status.Text = "安装包 " + HumanSize(info.AssetSize)
                    + "，下载完成后自动安装并重启，设置与窗口位置都会保留。";
                _btnPrimary.Text = "立即更新";
                _btnPrimary.Enabled = true;
            }

            _btnLater.Visible = true;
            _btnSkip.Visible = true;
            _btnClose.Enabled = true;
        }

        // ---------- 检查 ----------
        private async Task RunCheckAsync()
        {
            if (_cts != null) _cts.Dispose();
            _cts = new CancellationTokenSource();

            var r = await UpdateService.CheckAsync(AppVersion.Current, _cts.Token);
            AppConfig.MarkUpdateChecked();

            if (IsDisposed || Disposing) return;

            if (!r.Ok)
            {
                SetErrorState(r.Message);
                return;
            }
            if (!r.NewerAvailable)
            {
                SetLatestState(r.Message);
                return;
            }

            _info = r.Info;
            ShowInfo(_info);
            Log.I(LogKind.Update, "更新：发现新版本 v" + _info.Version + "，等待用户确认");
        }

        // ---------- 下载 / 安装 ----------
        private async void OnPrimaryClick(object sender, EventArgs e)
        {
            if (_downloading)
            {
                // 再点一次＝取消
                try { if (_cts != null) _cts.Cancel(); } catch { }
                _status.Text = "正在取消…";
                return;
            }

            if (_info == null || !_info.HasAsset)
            {
                OpenReleasesPage();
                return;
            }
            if (!_installable)
            {
                OpenReleasesPage();
                return;
            }

            _downloading = true;
            _btnPrimary.Text = "取消下载";
            _btnLater.Enabled = false;
            _btnSkip.Enabled = false;
            _btnClose.Enabled = false;
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 0;
            _status.ForeColor = Color.FromArgb(90, 90, 90);
            _status.Text = "准备下载…";

            if (_cts != null) _cts.Dispose();
            _cts = new CancellationTokenSource();

            try
            {
                var progress = new Progress<DownloadProgress>(OnProgress);
                var path = await UpdateService.DownloadAsync(_info, progress, _cts.Token);

                if (IsDisposed || Disposing) return;

                UpdateService.CleanupOldDownloads(path);
                AppConfig.SetLastUpdatedVersion(_info.Version);

                _status.Text = "校验通过，正在启动安装程序…";
                _bar.Value = 1000;

                UpdateService.RunInstaller(path);

                // 安装程序会 taskkill 旧实例并重新拉起；这里主动退出更干净（先落日志）
                _closedForInstall = true;
                if (_onExitForInstall != null) _onExitForInstall();
                else Close();
            }
            catch (OperationCanceledException)
            {
                Log.I(LogKind.Update, "更新：用户取消下载");
                ResetAfterDownload("已取消下载。", Color.FromArgb(150, 110, 40));
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Update, "更新：下载或安装失败", ex);
                ResetAfterDownload("更新失败：" + ex.Message, Color.FromArgb(176, 60, 60));
            }
            finally
            {
                _downloading = false;
            }
        }

        private void ResetAfterDownload(string message, Color color)
        {
            try
            {
                if (IsDisposed || Disposing) return;
                _status.Text = message;
                _status.ForeColor = color;
                _bar.Style = ProgressBarStyle.Continuous;
                _bar.Value = 0;
                _btnPrimary.Text = "重试下载";
                _btnPrimary.Enabled = true;
                _btnLater.Enabled = true;
                _btnSkip.Enabled = true;
                _btnClose.Enabled = true;
            }
            catch { }
        }

        private void OnProgress(DownloadProgress p)
        {
            try
            {
                if (IsDisposed || Disposing) return;

                int v = (int)Math.Round(p.Fraction * 1000);
                if (v < _bar.Minimum) v = _bar.Minimum;
                if (v > _bar.Maximum) v = _bar.Maximum;
                _bar.Value = v;

                var sb = new StringBuilder();
                sb.Append("正在下载 ").Append((p.Fraction * 100).ToString("0")).Append("%");
                if (p.Total > 0)
                    sb.Append("（").Append(HumanSize(p.Received)).Append(" / ").Append(HumanSize(p.Total)).Append("）");
                if (p.BytesPerSecond > 0)
                    sb.Append(" · ").Append(HumanSize((long)p.BytesPerSecond)).Append("/s");
                _status.Text = sb.ToString();
            }
            catch { }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_closedForInstall)
            {
                try { if (_cts != null) _cts.Cancel(); } catch { }
            }
            base.OnFormClosing(e);
        }

        // ---------- 小工具 ----------
        private void OpenReleasesPage()
        {
            try
            {
                var url = _info != null && !string.IsNullOrEmpty(_info.HtmlUrl)
                    ? _info.HtmlUrl : UpdateService.ReleasesPage;
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url)
                {
                    UseShellExecute = true
                });
                Log.I(LogKind.Update, "更新：打开发布页面 " + url);
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Update, "打开发布页面失败", ex);
            }
        }

        private static string HumanSize(long bytes)
        {
            if (bytes <= 0) return "0 B";
            if (bytes < 1024) return bytes + " B";
            double kb = bytes / 1024.0;
            if (kb < 1024) return kb.ToString("0.0") + " KB";
            double mb = kb / 1024.0;
            if (mb < 1024) return mb.ToString("0.0") + " MB";
            return (mb / 1024.0).ToString("0.00") + " GB";
        }

        /// <summary>
        /// Release 正文是 Markdown。这里不做完整渲染，只做"去掉标记符号"的轻量清洗：
        /// 标题变【】、列表变 ·、去掉 ** 与 `、[文本](url) 展开成"文本（url）"，
        /// 目的是让用户直接看懂更新了什么，而不是看到一堆星号。
        /// </summary>
        private static string SanitizeNotes(string md)
        {
            if (string.IsNullOrWhiteSpace(md)) return "（该版本没有填写更新说明）";

            var sb = new StringBuilder();
            foreach (var raw in md.Replace("\r\n", "\n").Split('\n'))
            {
                var line = raw.TrimEnd();
                if (line.StartsWith("#### ")) { sb.AppendLine("【" + line.Substring(5).Trim() + "】"); continue; }
                if (line.StartsWith("### ")) { sb.AppendLine("【" + line.Substring(4).Trim() + "】"); continue; }
                if (line.StartsWith("## ")) { sb.AppendLine("【" + line.Substring(3).Trim() + "】"); continue; }
                if (line.StartsWith("# ")) { sb.AppendLine("【" + line.Substring(2).Trim() + "】"); continue; }
                if (line.StartsWith("- ") || line.StartsWith("* ")) line = "· " + line.Substring(2);

                line = Regex.Replace(line, @"\[([^\]]*)\]\(([^)]*)\)", "$1（$2）");
                line = line.Replace("**", "").Replace("`", "");
                sb.AppendLine(line);
            }
            return sb.ToString().Trim();
        }

        private static Bitmap ToBitmap(Icon icon)
        {
            try { return icon.ToBitmap(); }
            catch { return null; }
        }
    }
}
