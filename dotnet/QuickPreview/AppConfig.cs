using System;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Windows.Forms;

namespace QuickPreview
{
    /// <summary>
    /// 用户偏好持久化（%LOCALAPPDATA%\QuickPreview\config.json）。
    /// 目前只存预览窗口的位置与大小——用户把窗口拖到副屏、调成自己喜欢的尺寸后，
    /// 下次按空格预览应该保持同样的位置和大小，否则每次都要重新摆一遍。
    /// </summary>
    public static class AppConfig
    {
        public sealed class Data
        {
            public int WindowX { get; set; } = int.MinValue;
            public int WindowY { get; set; } = int.MinValue;
            public int WindowWidth { get; set; }
            public int WindowHeight { get; set; }
        }

        private const int MinWidth = 640;
        private const int MinHeight = 480;
        private const int DefaultWidth = 1040;
        private const int DefaultHeight = 720;

        public static readonly string Dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "QuickPreview");

        public static readonly string FilePath = Path.Combine(Dir, "config.json");

        private static readonly object _lock = new object();
        private static Data _data;

        private static Data Current
        {
            get
            {
                if (_data != null) return _data;
                lock (_lock)
                {
                    if (_data != null) return _data;
                    try
                    {
                        if (File.Exists(FilePath))
                        {
                            var json = File.ReadAllText(FilePath);
                            _data = JsonSerializer.Deserialize<Data>(json) ?? new Data();
                        }
                    }
                    catch (Exception ex)
                    {
                        Log.W(LogKind.App, "读取配置失败，使用默认值：" + ex.Message);
                    }
                    if (_data == null) _data = new Data();
                    return _data;
                }
            }
        }

        /// <summary>
        /// 取上次保存的窗口矩形。没有保存过、或已不在任何屏幕可见范围内（换显示器 /
        /// 分辨率变化）时返回 null，由调用方使用默认位置。
        /// </summary>
        public static Rectangle? LoadWindowBounds()
        {
            var d = Current;
            if (d.WindowWidth <= 0 || d.WindowHeight <= 0) return null;
            if (d.WindowX == int.MinValue || d.WindowY == int.MinValue) return null;

            int w = Math.Max(MinWidth, d.WindowWidth);
            int h = Math.Max(MinHeight, d.WindowHeight);
            var rect = new Rectangle(d.WindowX, d.WindowY, w, h);

            // 至少要有 120x40 落在某个屏幕工作区里，否则视为失效
            foreach (var s in Screen.AllScreens)
            {
                var inter = Rectangle.Intersect(rect, s.WorkingArea);
                if (inter.Width >= 120 && inter.Height >= 40) return rect;
            }
            return null;
        }

        /// <summary>默认窗口矩形：居中，尺寸取上次大小（没有则 1040x720）。</summary>
        public static Rectangle DefaultWindowBounds()
        {
            var d = Current;
            int w = d.WindowWidth >= MinWidth ? d.WindowWidth : DefaultWidth;
            int h = d.WindowHeight >= MinHeight ? d.WindowHeight : DefaultHeight;

            var wa = Screen.PrimaryScreen.WorkingArea;
            w = Math.Min(w, wa.Width);
            h = Math.Min(h, wa.Height);
            return new Rectangle(
                wa.Left + (wa.Width - w) / 2,
                wa.Top + (wa.Height - h) / 2,
                w, h);
        }

        public static void SaveWindowBounds(Rectangle b)
        {
            if (b.Width <= 0 || b.Height <= 0) return;
            var d = Current;
            // 尺寸没变化就不写盘（拖动位置时也只在结束时调用一次，开销可忽略）
            if (d.WindowX == b.X && d.WindowY == b.Y
                && d.WindowWidth == b.Width && d.WindowHeight == b.Height) return;

            d.WindowX = b.X;
            d.WindowY = b.Y;
            d.WindowWidth = b.Width;
            d.WindowHeight = b.Height;

            try
            {
                Directory.CreateDirectory(Dir);
                // 先写临时文件再替换，避免断电/崩溃留下半截 JSON 导致下次启动读配置失败
                var tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(d, new JsonSerializerOptions { WriteIndented = true }));
                if (File.Exists(FilePath)) File.Delete(FilePath);
                File.Move(tmp, FilePath);
            }
            catch (Exception ex)
            {
                Log.W(LogKind.App, "保存窗口位置失败：" + ex.Message);
            }
        }

        public const int MinimumWidth = MinWidth;
        public const int MinimumHeight = MinHeight;
    }
}
