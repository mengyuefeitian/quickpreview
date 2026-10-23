using System;
using System.Collections.Generic;
using System.IO;

namespace QuickPreview
{
    /// <summary>
    /// 可预览的扩展名与 MIME 映射。
    ///
    /// 【必须与 src/shared/mime.ts 保持一致】
    /// 宿主用它决定「按空格要不要接管」，渲染层用它决定「怎么画」。
    /// 两边一旦漂移就会出现「文件类型前端认识、宿主却判定不支持」——
    /// 表现为按空格没反应或提示不支持（.ps1 / .bat 曾经就是这样）。
    /// 一致性由 test-samples/check_ext_parity.py 校验，改完请跑一次。
    /// </summary>
    public static class FileTypes
    {
        /// <summary>按等宽字体渲染的纯文本 / 代码。</summary>
        private static readonly HashSet<string> TextExt =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                // 纯文本 / 配置
                ".txt", ".md", ".mkd", ".markdown", ".rst", ".log", ".text",
                ".json", ".jsonc", ".json5", ".yaml", ".yml", ".xml", ".ini", ".cfg", ".conf",
                ".properties", ".env",
                // 前端
                ".css", ".scss", ".sass", ".less", ".html", ".htm", ".vue", ".svelte", ".astro",
                ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
                // 脚本
                ".py", ".pyw", ".pyi", ".sh", ".bash", ".zsh", ".fish",
                ".bat", ".cmd", ".ps1", ".psm1", ".psd1",
                // 系统 / 后端
                ".java", ".kt", ".kts", ".scala", ".groovy", ".gradle",
                ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".hh",
                ".cs", ".fs", ".fsx", ".vb",
                ".go", ".rs", ".rb", ".php", ".lua", ".pl", ".pm", ".r",
                ".swift", ".m", ".mm", ".dart",
                // 数据 / 构建 / 其它
                ".sql", ".toml", ".asm", ".s", ".tex", ".proto", ".graphql", ".gql",
                ".tf", ".tfvars", ".hcl", ".mk", ".cmake",
                // 点文件（Path.GetExtension(".gitignore") 返回 ".gitignore"）
                ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc", ".dockerignore"
            };

        /// <summary>非文本类（图片 / 文档 / 媒体 / 压缩包）。</summary>
        private static readonly HashSet<string> BinaryExt =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                // 图片
                ".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".gif", ".bmp", ".webp", ".svg", ".ico",
                ".tif", ".tiff", ".avif", ".heic",
                // 文档
                ".pdf",
                ".doc", ".docx", ".docm", ".xls", ".xlsx", ".xlsm", ".csv", ".tsv",
                ".ppt", ".pptx", ".pptm",
                // 压缩包（zip）
                ".zip",
                // 音频
                ".mp3", ".flac", ".wav", ".ape", ".ogg", ".m4a", ".aac", ".wma",
                // 视频
                ".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".m4v", ".flv", ".mpg", ".mpeg"
            };

        /// <summary>
        /// 单文件网页（MHTML / MHT）：一个文件里装着 HTML 与它引用的图片、CSS。
        /// 不能算纯文本 —— 按文本下发会被当成源码显示，渲染层要自己拆 MIME 分包。
        /// </summary>
        private static readonly HashSet<string> WebArchiveExt =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                ".mhtml", ".mht"
            };

        /// <summary>没有扩展名、但确定是纯文本的文件名。</summary>
        private static readonly HashSet<string> TextNames =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "makefile", "dockerfile", "containerfile", "rakefile", "gemfile", "vagrantfile",
                "jenkinsfile", "procfile", "brewfile", "cmakelists.txt", "license", "readme",
                "changelog", "notice", "authors", "contributors"
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
                [".xml"] = "application/xml", [".csv"] = "text/csv; charset=utf-8",
                [".tsv"] = "text/tab-separated-values; charset=utf-8",
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
                var ext = Path.GetExtension(path);
                if (!string.IsNullOrEmpty(ext)
                    && (TextExt.Contains(ext) || BinaryExt.Contains(ext) || WebArchiveExt.Contains(ext)))
                    return true;

                // Dockerfile / Makefile 这类没有扩展名的纯文本
                var name = Path.GetFileName(path);
                return !string.IsNullOrEmpty(name) && TextNames.Contains(name);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>是否按纯文本 / 代码处理（决定 MIME 与渲染方式）。</summary>
        public static bool IsTextual(string path)
        {
            try
            {
                var ext = Path.GetExtension(path);
                if (!string.IsNullOrEmpty(ext) && TextExt.Contains(ext)) return true;
                var name = Path.GetFileName(path);
                return !string.IsNullOrEmpty(name) && TextNames.Contains(name);
            }
            catch { return false; }
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
            if (WebArchiveExt.Contains(ext)) return "网页存档";
            if (ext == ".mp3" || ext == ".flac" || ext == ".wav" || ext == ".ape" ||
                ext == ".ogg" || ext == ".m4a" || ext == ".aac" || ext == ".wma") return "音频";
            if (ext == ".mp4" || ext == ".mkv" || ext == ".avi" || ext == ".mov" ||
                ext == ".webm" || ext == ".wmv" || ext == ".m4v" || ext == ".flv" ||
                ext == ".mpg" || ext == ".mpeg") return "视频";
            if (IsTextual(path)) return "文本/代码";
            return "未知";
        }

        public static string MimeOf(string path)
        {
            try
            {
                var ext = Path.GetExtension(path);
                if (WebArchiveExt.Contains(ext)) return "multipart/related";
                if (Mimes.TryGetValue(ext, out var m)) return m;

                // 代码/配置没有逐个登记 MIME，统一按纯文本下发，
                // 否则内容类型是 octet-stream，页面按二进制处理会显示成乱码。
                if (IsTextual(path)) return "text/plain; charset=utf-8";
            }
            catch { }

            return "application/octet-stream";
        }
    }
}
