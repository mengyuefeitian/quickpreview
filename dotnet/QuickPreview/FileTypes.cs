using System;
using System.Collections.Generic;
using System.IO;

namespace QuickPreview
{
    /// <summary>可预览的扩展名与 MIME 映射。</summary>
    public static class FileTypes
    {
        private static readonly HashSet<string> Previewable =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                // 图片
                ".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".gif", ".bmp", ".webp", ".svg", ".ico",
                ".tif", ".tiff", ".avif", ".heic",
                // 文本 / 代码
                ".txt", ".md", ".log", ".json", ".xml", ".yml", ".yaml", ".ini", ".cfg", ".toml",
                ".js", ".ts", ".jsx", ".tsx", ".css", ".scss", ".html", ".htm", ".vue",
                ".py", ".java", ".c", ".h", ".cpp", ".cs", ".go", ".rb", ".php", ".rs", ".sh", ".sql",
                // 文档
                ".pdf",
                ".doc", ".docx", ".docm", ".xls", ".xlsx", ".xlsm", ".csv", ".tsv", ".ppt", ".pptx", ".pptm",
                // 压缩包（zip）
                ".zip",
                // 音频
                ".mp3", ".flac", ".wav", ".ape", ".ogg", ".m4a", ".aac", ".wma",
                // 视频
                ".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".m4v", ".flv"
            };

        private static readonly Dictionary<string, string> Mimes =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
                // .jfif / .jpe 本质就是 JPEG：Chromium 只要能拿到 image/jpeg 就能解码显示
                [".jfif"] = "image/jpeg", [".jpe"] = "image/jpeg",
                [".avif"] = "image/avif", [".heic"] = "image/heic",
                [".gif"] = "image/gif", [".bmp"] = "image/bmp", [".webp"] = "image/webp",
                [".svg"] = "image/svg+xml", [".ico"] = "image/x-icon",
                [".tif"] = "image/tiff", [".tiff"] = "image/tiff",
                [".txt"] = "text/plain; charset=utf-8", [".md"] = "text/markdown; charset=utf-8",
                [".log"] = "text/plain; charset=utf-8", [".json"] = "application/json",
                [".xml"] = "application/xml", [".csv"] = "text/csv; charset=utf-8", [".tsv"] = "text/tab-separated-values; charset=utf-8",
                [".pdf"] = "application/pdf",
                [".zip"] = "application/zip",
                [".mp3"] = "audio/mpeg", [".flac"] = "audio/flac", [".wav"] = "audio/wav",
                [".ape"] = "audio/x-ape", [".ogg"] = "audio/ogg", [".m4a"] = "audio/mp4",
                [".aac"] = "audio/aac", [".wma"] = "audio/x-ms-wma",
                [".mp4"] = "video/mp4", [".mkv"] = "video/x-matroska", [".avi"] = "video/x-msvideo",
                [".mov"] = "video/quicktime", [".webm"] = "video/webm", [".wmv"] = "video/x-ms-wmv",
                [".m4v"] = "video/mp4", [".flv"] = "video/x-flv"
            };

        public static bool IsPreviewable(string path)
        {
            try
            {
                return Previewable.Contains(Path.GetExtension(path));
            }
            catch
            {
                return false;
            }
        }

        /// <summary>粗略分类，仅用于日志与提示。</summary>
        public static string CategoryOf(string path)
        {
            try { if (Directory.Exists(path)) return "文件夹"; }
            catch { }

            string ext;
            try { ext = (Path.GetExtension(path) ?? string.Empty).ToLowerInvariant(); }
            catch { return "未知"; }

            if (ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".jpe" || ext == ".jfif" ||
                ext == ".gif" || ext == ".bmp" || ext == ".webp" || ext == ".svg" || ext == ".ico" ||
                ext == ".tif" || ext == ".tiff" || ext == ".avif" || ext == ".heic")
                return "图片";
            if (ext == ".pdf") return "PDF";
            if (ext == ".doc" || ext == ".docx" || ext == ".docm") return "Word";
            if (ext == ".xls" || ext == ".xlsx" || ext == ".xlsm" || ext == ".csv" || ext == ".tsv") return "Excel";
            if (ext == ".ppt" || ext == ".pptx" || ext == ".pptm") return "PPT";
            if (ext == ".zip") return "压缩包";
            if (ext == ".mp3" || ext == ".flac" || ext == ".wav" || ext == ".ape" ||
                ext == ".ogg" || ext == ".m4a" || ext == ".aac" || ext == ".wma") return "音频";
            if (ext == ".mp4" || ext == ".mkv" || ext == ".avi" || ext == ".mov" ||
                ext == ".webm" || ext == ".wmv" || ext == ".m4v" || ext == ".flv") return "视频";
            return "文本/代码";
        }

        public static string MimeOf(string path)
        {
            try
            {
                var ext = Path.GetExtension(path);
                if (Mimes.TryGetValue(ext, out var m)) return m;
            }
            catch { }

            return "application/octet-stream";
        }
    }
}
