using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;

namespace QuickPreview
{
    /// <summary>
    /// EMF / WMF 元文件 → PNG。
    ///
    /// 【为什么必须有这一步】Word 里「警告 / 注意 / 说明 / 窍门」这类符号标记，
    /// 以及从 Visio、画图、旧版 Office 粘进来的图形，在 docx 包里往往是
    /// word/media/imageN.emf（矢量元文件），而不是 PNG。
    /// Chromium 不解码 EMF/WMF ⇒ docx-preview 只能把它塞进 &lt;img&gt;，
    /// 页面上就是 naturalWidth = 0 的碎图标（实测「符号约定」表格 4 个图标全废）。
    /// 浏览器侧没有任何办法，只能由宿主用 GDI+ 重放元文件、光栅化成 PNG 再回传。
    ///
    /// 放大倍数取 3：元文件是矢量，按 3 倍重放后即使预览放大到 300% 也不糊；
    /// 边长上限 4000px，防止极端元文件（整页贴图）把内存吃光。
    /// </summary>
    internal static class MetafileConverter
    {
        private const double DefaultScale = 3.0;
        private const double MaxSide = 4000;

        /// <summary>
        /// 转换成功返回 PNG 字节；失败返回 null 并写出原因（调用方只记日志，不影响整篇预览）。
        /// </summary>
        public static byte[] ToPng(byte[] data, out string error)
        {
            return ToPng(data, DefaultScale, out error);
        }

        public static byte[] ToPng(byte[] data, double scale, out string error)
        {
            error = null;
            if (data == null || data.Length < 8)
            {
                error = "数据为空";
                return null;
            }

            try
            {
                using (var input = new MemoryStream(data, false))
                using (var meta = OpenMetafile(input))
                {
                    if (meta == null)
                    {
                        error = "不是可解析的 EMF/WMF 元文件";
                        return null;
                    }

                    // 逻辑尺寸：Image.Width/Height 已按元文件自身 DPI 折算成像素；
                    // 少数元文件头里 DPI 缺失会返回 0，退回 header bounds。
                    double sw = meta.Width;
                    double sh = meta.Height;
                    if (sw <= 0 || sh <= 0)
                    {
                        var hdr = meta.GetMetafileHeader();
                        sw = hdr.Bounds.Width;
                        sh = hdr.Bounds.Height;
                    }
                    if (sw <= 0 || sh <= 0)
                    {
                        error = "元文件尺寸为 0";
                        return null;
                    }

                    double k = scale;
                    double longest = Math.Max(sw, sh) * k;
                    if (longest > MaxSide) k *= MaxSide / longest;

                    int w = Math.Max(1, (int)Math.Round(sw * k));
                    int h = Math.Max(1, (int)Math.Round(sh * k));

                    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
                    {
                        using (var g = Graphics.FromImage(bmp))
                        {
                            // 元文件多半是透明底的线条画，先清成透明再重放，
                            // 否则会得到黑底（默认 Bitmap 是黑色 0,0,0）。
                            g.Clear(Color.Transparent);
                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            g.CompositingQuality = CompositingQuality.HighQuality;
                            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                            g.DrawImage(meta, new Rectangle(0, 0, w, h));
                        }

                        using (var output = new MemoryStream())
                        {
                            bmp.Save(output, ImageFormat.Png);
                            return output.ToArray();
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }

        /// <summary>
        /// Metafile 构造对「裸 WMF」（没有 Aldus 头）会直接抛异常；
        /// 先按原样试，失败后给数据前补一个 22 字节的可放置头再试一次。
        /// </summary>
        private static Metafile OpenMetafile(Stream stream)
        {
            try { return new Metafile(stream); }
            catch { /* 走补头分支 */ }

            stream.Position = 0;
            var raw = new byte[stream.Length];
            stream.Read(raw, 0, raw.Length);

            using (var patched = new MemoryStream(BuildPlaceableWmf(raw), false))
            {
                try { return new Metafile(patched); }
                catch { return null; }
            }
        }

        /// <summary>给裸 WMF 套上 Aldus 可放置头（22 字节），GDI+ 才肯解析。</summary>
        private static byte[] BuildPlaceableWmf(byte[] raw)
        {
            var ms = new MemoryStream(22 + raw.Length);
            using (var bw = new BinaryWriter(ms, System.Text.Encoding.ASCII, true))
            {
                bw.Write((uint)0x9AC6CDD7);   // 可放置标记
                bw.Write((ushort)0);          // 保留
                bw.Write((short)0);           // left
                bw.Write((short)0);           // top
                bw.Write((short)0);           // right（0 ⇒ 由 GDI 按内容算）
                bw.Write((short)0);           // bottom
                bw.Write((ushort)96);         // 每英寸单位数
                bw.Write((uint)0);            // 保留
                bw.Write((ushort)0);          // 校验和（GDI+ 不校验）
                bw.Write(raw);
            }
            return ms.ToArray();
        }
    }
}
