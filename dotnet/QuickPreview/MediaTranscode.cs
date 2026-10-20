using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace QuickPreview
{
    public class MediaResult
    {
        public bool ok;
        public string path;
        public string mime;
        public string error;
    }

    /// <summary>
    /// ape/mkv/avi 等 Chromium 不原生支持的格式，用内置 ffmpeg 按需转码：
    /// 音频 → flac，视频 → mp4(h264+aac)。结果按文件路径哈希缓存，二次预览秒开。
    /// </summary>
    public static class MediaTranscode
    {
        // 浏览器可直接播放、无需转码
        private static readonly string[] NativePlayable =
            { ".mp4", ".webm", ".ogg", ".wav", ".mp3", ".m4a", ".aac", ".m4v" };

        private static readonly string[] AudioExts =
            { ".mp3", ".flac", ".wav", ".ape", ".ogg", ".m4a", ".aac", ".wma" };

        public static string FfmpegPath => Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe");
        public static string CacheDir => Path.Combine(Path.GetTempPath(), "QuickPreviewCache");

        public static async Task<MediaResult> PrepareAsync(string input)
        {
            string ext = Path.GetExtension(input).ToLowerInvariant();

            if (Array.IndexOf(NativePlayable, ext) >= 0)
            {
                Log.D(LogKind.Media, "无需转码，直接播放：" + input);
                return new MediaResult { ok = true, path = input, mime = FileTypes.MimeOf(input) };
            }

            bool isAudio = Array.IndexOf(AudioExts, ext) >= 0;
            string targetExt = isAudio ? ".flac" : ".mp4";
            string outPath = Path.Combine(CacheDir, Hash(input) + targetExt);

            try
            {
                if (File.Exists(outPath))
                {
                    Log.I(LogKind.Media, "命中转码缓存：" + outPath);
                    return new MediaResult { ok = true, path = outPath, mime = FileTypes.MimeOf(outPath) };
                }

                Directory.CreateDirectory(CacheDir);

                string args = isAudio
                    ? $"-y -i \"{input}\" -vn -c:a flac \"{outPath}\""
                    : $"-y -i \"{input}\" -map 0:v:0 -map 0:a? -c:v libx264 -preset ultrafast -crf 28 -c:a aac -movflags +faststart \"{outPath}\"";

                if (!File.Exists(FfmpegPath))
                {
                    Log.E(LogKind.Media, "ffmpeg.exe 不存在：" + FfmpegPath);
                    return new MediaResult { ok = false, error = "缺少 ffmpeg.exe，无法转码该格式" };
                }

                var psi = new ProcessStartInfo(FfmpegPath, args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true
                };

                Log.I(LogKind.Media, "开始转码：" + input + " → " + targetExt);
                Log.D(LogKind.Media, "ffmpeg 命令行：" + FfmpegPath + " " + args);

                var sw = System.Diagnostics.Stopwatch.StartNew();
                int exitCode = -1;
                string stderr = null;

                using (var p = Process.Start(psi))
                {
                    if (p == null) return new MediaResult { ok = false, error = "无法启动 ffmpeg" };
                    stderr = await p.StandardError.ReadToEndAsync().ConfigureAwait(false);
                    await p.WaitForExitAsync().ConfigureAwait(false);
                    exitCode = p.ExitCode;
                }
                sw.Stop();

                if (File.Exists(outPath))
                {
                    Log.I(LogKind.Media, string.Format("转码完成（{0}ms，exit={1}）：{2:N0} 字节 → {3}",
                        sw.ElapsedMilliseconds, exitCode, new FileInfo(outPath).Length, outPath));
                    return new MediaResult { ok = true, path = outPath, mime = FileTypes.MimeOf(outPath) };
                }

                var tail = stderr;
                if (!string.IsNullOrEmpty(tail) && tail.Length > 800)
                    tail = tail.Substring(tail.Length - 800);
                Log.E(LogKind.Media, string.Format("转码失败（{0}ms，exit={1}）：{2} | ffmpeg 输出尾部：{3}",
                    sw.ElapsedMilliseconds, exitCode, input, tail));

                return new MediaResult
                {
                    ok = false,
                    error = "转码失败（exit=" + exitCode + "），详见 media.log"
                };
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Media, "转码异常：" + input, ex);
                return new MediaResult { ok = false, error = ex.Message };
            }
        }

        private static string Hash(string s)
        {
            using (var md5 = MD5.Create())
            {
                var bytes = md5.ComputeHash(Encoding.UTF8.GetBytes(s));
                return BitConverter.ToString(bytes).Replace("-", "").Substring(0, 16);
            }
        }
    }
}
