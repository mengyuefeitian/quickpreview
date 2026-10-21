using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace QuickPreview
{
    /// <summary>
    /// 「关于」窗口：展示产品名称与版本（托盘右键菜单 → 关于 QuickPreview）。
    /// 版本号统一取自 AppVersion.Current（由程序集版本派生），避免各处硬编码不一致。
    /// </summary>
    public class AboutForm : Form
    {
        /// <summary>项目主页。关于窗口、安装包信息统一用这一处，避免各处写不一样。</summary>
        public const string RepoUrl = "https://github.com/mengyuefeitian/quickpreview";

        public AboutForm()
        {
            Text = "关于 QuickPreview";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            TopMost = true;
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei", 9f);
            ClientSize = new Size(460, 352);
            BackColor = Color.White;
            try { Icon = MainForm.AppIcon(); } catch { }

            var iconBox = new PictureBox
            {
                Location = new Point(24, 24),
                Size = new Size(56, 56),
                SizeMode = PictureBoxSizeMode.StretchImage,
                Image = ToBitmap(MainForm.AppIcon())
            };

            var title = new Label
            {
                Text = "QuickPreview",
                Font = new Font("Microsoft YaHei", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 30, 30),
                Location = new Point(98, 26),
                AutoSize = true
            };

            var ver = new Label
            {
                Text = "版本 " + AppVersion.Current,
                Font = new Font("Microsoft YaHei", 10f),
                ForeColor = Color.FromArgb(90, 90, 90),
                Location = new Point(100, 56),
                AutoSize = true
            };

            var desc = new Label
            {
                Text = "在文件资源管理器或桌面中选中文件，按空格键即可快速预览。",
                Location = new Point(24, 100),
                Size = new Size(412, 22),
                ForeColor = Color.FromArgb(60, 60, 60)
            };

            var info = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BorderStyle = BorderStyle.FixedSingle,
                Location = new Point(24, 132),
                Size = new Size(412, 120),
                BackColor = Color.FromArgb(248, 248, 248),
                ForeColor = Color.FromArgb(50, 50, 50),
                Font = new Font("Consolas", 9f),
                Text = BuildInfo()
            };

            var link = new LinkLabel
            {
                Text = "GitHub：" + RepoUrl,
                Location = new Point(24, 260),
                Size = new Size(412, 20),
                Font = new Font("Microsoft YaHei", 9f),
                LinkColor = Color.FromArgb(0, 102, 204),
                VisitedLinkColor = Color.FromArgb(0, 102, 204)
            };
            link.Links.Add(0, link.Text.Length, RepoUrl);
            link.LinkClicked += (s, e) => OpenUrl((string)e.Link.LinkData);

            var btnLog = new Button
            {
                Text = "查看日志…",
                Location = new Point(24, 290),
                Size = new Size(110, 32)
            };
            btnLog.Click += (s, e) => LogViewerForm.OpenDir(Log.LogDir);

            var btnOk = new Button
            {
                Text = "确定",
                Location = new Point(326, 290),
                Size = new Size(110, 32)
            };
            // 非模态显示（托盘菜单里弹模态框容易卡住菜单），点确定直接关闭
            btnOk.Click += (s, e) => Close();
            AcceptButton = btnOk;

            Controls.Add(iconBox);
            Controls.Add(title);
            Controls.Add(ver);
            Controls.Add(desc);
            Controls.Add(info);
            Controls.Add(link);
            Controls.Add(btnLog);
            Controls.Add(btnOk);
        }

        private static void OpenUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                Log.I(LogKind.App, "打开项目主页：" + url);
            }
            catch (Exception ex)
            {
                Log.E(LogKind.App, "打开链接失败：" + url, ex);
            }
        }

        private static string BuildInfo()
        {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine("产品：QuickPreview —— 空格键快速预览服务");
            sb.AppendLine("版本：" + AppVersion.Current);
            sb.AppendLine("主页：" + RepoUrl);
            sb.AppendLine("运行时：.NET " + Environment.Version);
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                sb.AppendLine("程序：" + Path.GetFileName(asm.Location));
                sb.AppendLine("安装目录：" + AppContext.BaseDirectory);
            }
            catch { }

            sb.AppendLine("支持格式：图片 / 文本 / PDF / Word(doc,docx) / Excel(xls,xlsx)");
            sb.AppendLine("          PPT(pptx) / 音频(mp3,flac,ape…) / 视频(mp4,mkv…) / 文件夹");
            sb.AppendLine("快捷键：空格=预览或关闭，← → = PDF 翻页，↑ ↓ = 切换文件，Esc = 退出");
            return sb.ToString();
        }

        private static Bitmap ToBitmap(Icon icon)
        {
            try { return icon.ToBitmap(); }
            catch { return null; }
        }
    }
}
