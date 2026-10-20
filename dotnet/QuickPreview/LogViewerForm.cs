using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace QuickPreview
{
    /// <summary>日志查看窗口：按类别查看，最新日志在最上面（文件本身即倒序存储）。</summary>
    public class LogViewerForm : Form
    {
        private const int MaxLines = 2000;          // 最多加载的行数（文件可能很大）
        private const int AutoRefreshMs = 3000;

        private readonly ComboBox _cmb = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 320 };
        private readonly TextBox _txt = new TextBox();
        private readonly CheckBox _auto = new CheckBox { Text = "自动刷新", AutoSize = true, Checked = true };
        private readonly Label _status = new Label { Dock = DockStyle.Bottom, Height = 24, TextAlign = ContentAlignment.MiddleLeft };
        private readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer { Interval = AutoRefreshMs };

        public LogViewerForm()
        {
            Text = "QuickPreview 日志 v" + AppVersion.Current;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1080, 680);
            Font = new Font("Microsoft YaHei UI", 9f);
            Icon = MainForm.AppIcon();

            var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(8, 8, 0, 0) };
            top.Controls.Add(_cmb);
            AddButton(top, "刷新", (s, e) => Reload());
            AddButton(top, "打开日志目录", (s, e) => OpenDir());
            AddButton(top, "导出诊断包", (s, e) => Export());
            AddButton(top, "清空当前日志", (s, e) => ClearCurrent());
            top.Controls.Add(_auto);

            _txt.Multiline = true;
            _txt.ScrollBars = ScrollBars.Both;
            _txt.WordWrap = false;
            _txt.ReadOnly = true;
            _txt.Font = new Font("Consolas", 9.5f);
            _txt.Dock = DockStyle.Fill;
            _txt.BackColor = Color.White;

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 30 };
            bottom.Controls.Add(_status);

            // 顺序：Fill 控件最后添加，避免被顶部/底部面板覆盖
            Controls.Add(_txt);
            Controls.Add(top);
            Controls.Add(bottom);

            FillCombo();
            _cmb.SelectedIndexChanged += (s, e) => Reload();
            _timer.Tick += (s, e) => { if (_auto.Checked) Reload(); };
            _timer.Start();

            Reload();
        }

        private static void AddButton(Control parent, string text, EventHandler onClick)
        {
            var b = new Button { Text = text, AutoSize = true, Margin = new Padding(6, 0, 0, 0) };
            b.Click += onClick;
            parent.Controls.Add(b);
        }

        // ---------- 文件列表 ----------
        private void FillCombo()
        {
            var keep = CurrentPath();
            _cmb.Items.Clear();

            foreach (LogKind k in Enum.GetValues(typeof(LogKind)))
            {
                var files = Log.FilesOf(k);
                for (int i = 0; i < files.Count; i++)
                {
                    var item = new FileItem(files[i], i == 0 ? k.ToString() : k.ToString() + " 备份" + i);
                    _cmb.Items.Add(item);
                }
                if (files.Count == 0)
                    _cmb.Items.Add(new FileItem(Log.PathOf(k, 0), k.ToString()));
            }

            int idx = 0;
            for (int i = 0; i < _cmb.Items.Count; i++)
            {
                if (string.Equals(((FileItem)_cmb.Items[i]).Path, keep, StringComparison.OrdinalIgnoreCase))
                {
                    idx = i;
                    break;
                }
            }
            _cmb.SelectedIndex = idx;
        }

        private string CurrentPath()
        {
            var it = _cmb.SelectedItem as FileItem;
            return it != null ? it.Path : Log.PathOf(LogKind.App, 0);
        }

        private LogKind CurrentKind()
        {
            var it = _cmb.SelectedItem as FileItem;
            if (it != null)
            {
                var name = Path.GetFileNameWithoutExtension(it.Path).Split('.')[0];
                if (Enum.TryParse(name, true, out LogKind k)) return k;
            }
            return LogKind.App;
        }

        // ---------- 加载 ----------
        private void Reload()
        {
            string path = CurrentPath();
            var sb = new StringBuilder();
            int shown = 0, total = 0;
            long size = 0;
            DateTime? lastWrite = null;

            try
            {
                if (File.Exists(path))
                {
                    var fi = new FileInfo(path);
                    size = fi.Length;
                    lastWrite = fi.LastWriteTime;

                    using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var sr = new StreamReader(fs, Encoding.UTF8))
                    {
                        string line;
                        while ((line = sr.ReadLine()) != null)
                        {
                            total++;
                            if (shown < MaxLines)
                            {
                                sb.AppendLine(line);
                                shown++;
                            }
                        }
                    }
                }
                else
                {
                    sb.AppendLine("（暂无日志：" + path + "）");
                }
            }
            catch (Exception ex)
            {
                sb.AppendLine("读取失败：" + ex.Message);
            }

            int selStart = _txt.SelectionStart;
            int selLen = _txt.SelectionLength;
            bool atTop = _txt.GetCharIndexFromPosition(new Point(1, 1)) == 0;

            _txt.Text = sb.ToString();
            if (!atTop && selLen == 0)
            {
                _txt.SelectionStart = Math.Min(selStart, _txt.TextLength);
                _txt.ScrollToCaret();
            }
            else
            {
                _txt.SelectionStart = 0;
                _txt.ScrollToCaret();
            }

            _status.Text = string.Format(
                "文件：{0}   大小：{1:N0} 字节   共 {2} 行（已显示最新 {3} 行）   最后写入：{4}   目录：{5}",
                Path.GetFileName(path), size, total, shown,
                lastWrite.HasValue ? lastWrite.Value.ToString("yyyy-MM-dd HH:mm:ss") : "-",
                Log.LogDir);
        }

        // ---------- 操作 ----------
        private void OpenDir()
        {
            try { Process.Start("explorer.exe", Log.LogDir); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "打开失败"); }
        }

        private void Export()
        {
            try
            {
                string dir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string zip = Log.ExportZip(dir);
                MessageBox.Show(this, "诊断包已导出到桌面：\n" + zip, "导出完成",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                try { Process.Start("explorer.exe", "/select,\"" + zip + "\""); } catch { }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "导出失败：" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ClearCurrent()
        {
            var kind = CurrentKind();
            if (MessageBox.Show(this, "清空【" + kind + "】的全部日志文件（含备份）？", "确认",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;

            Log.Clear(kind);
            FillCombo();
            Reload();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer.Stop();
                _timer.Dispose();
            }
            base.Dispose(disposing);
        }

        public static void OpenDir(string dir)
        {
            try { Process.Start("explorer.exe", dir); } catch { }
        }

        private sealed class FileItem
        {
            public string Path { get; private set; }
            private readonly string _label;

            public FileItem(string path, string label)
            {
                Path = path;
                _label = label;
            }

            public override string ToString()
            {
                return _label;
            }
        }
    }
}
