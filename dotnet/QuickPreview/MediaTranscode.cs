using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
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
    /// ape/mkv/avi 等 Chromium 不原生支持的格式，用内置 ffmpeg 按需转换：
    /// 音频 → flac，视频 → mp4。结果按文件路径哈希缓存，二次预览秒开。
    ///
    /// 视频有两条路：
    ///   1) **remux（-c copy）**：只换容器不重编码。mkv 里绝大多数是 h264/hevc + aac，
    ///      一部 2GB 电影几百毫秒就能转完、画质零损失。
    ///   2) 重编码（libx264）：只有 codec 本身 mp4/Chromium 不吃时才走（xvid、wmv3 等），
    ///      慢但没有别的选择。
    /// 以前不分情况一律重编码，"预览一部电影要等很久"主要就卡在这里。
    /// </summary>
    public static class MediaTranscode
    {
        // 浏览器可直接播放、无需转换。
        // 必须与 src/shared/mime.ts 的 AUDIO_PLAYABLE / VIDEO_PLAYABLE 保持一致：
        // 曾经这里漏了 .flac 和 .mov，导致"前端认为能直接放、宿主又去转一遍"，
        // 用户感知就是「FLAC 预览要等很久」。
        private static readonly string[] NativePlayable =
            { ".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".mp4", ".webm", ".mov", ".m4v" };

        private static readonly string[] AudioExts =
            { ".mp3", ".flac", ".wav", ".ape", ".ogg", ".m4a", ".aac", ".wma" };

        /// <summary>能直接放进 mp4 且 Chromium 认的视频编码。</summary>
        private static readonly string[] Mp4VideoCodecs = { "h264", "hevc", "av1", "vp9" };

        /// <summary>能直接放进 mp4 且 Chromium 认的音频编码（null = 没有音轨，也允许）。</summary>
        private static readonly string[] Mp4AudioCodecs = { "aac", "mp3" };

        public static string FfmpegPath => Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe");
        public static string CacheDir => Path.Combine(Path.GetTempPath(), "QuickPreviewCache");

        public static async Task<MediaResult> PrepareAsync(string input)
        {
            string ext = Path.GetExtension(input).ToLowerInvariant();

            if (Array.IndexOf(NativePlayable, ext) >= 0)
            {
                Log.D(LogKind.Media, "无需转换，直接播放：" + input);
                return new MediaResult { ok = true, path = input, mime = FileTypes.MimeOf(input) };
            }

            bool isAudio = Array.IndexOf(AudioExts, ext) >= 0;
            string targetExt = isAudio ? ".flac" : ".mp4";
            string outPath = Path.Combine(CacheDir, Hash(input) + targetExt);

            try
            {
                if (File.Exists(outPath))
                {
                    Log.I(LogKind.Media, "命中转换缓存：" + outPath);
                    return new MediaResult { ok = true, path = outPath, mime = FileTypes.MimeOf(outPath) };
                }

                Directory.CreateDirectory(CacheDir);

                if (!File.Exists(FfmpegPath))
                {
                    Log.E(LogKind.Media, "ffmpeg.exe 不存在：" + FfmpegPath);
                    return new MediaResult { ok = false, error = "缺少 ffmpeg.exe，无法转换该格式" };
                }

                // ---------- 视频：先判断能不能只换容器 ----------
                if (!isAudio)
                {
                    // 探测只需要读文件头，正常几十毫秒；8 秒还没结束说明文件异常，直接放弃探测
                    var probe = await RunFfmpegAsync($"-hide_banner -i \"{input}\"", 8000).ConfigureAwait(false);
                    string vcodec = MatchCodec(probe.stderr, "Video:");
                    string acodec = MatchCodec(probe.stderr, "Audio:");
                    Log.I(LogKind.Media, $"编码探测：video={vcodec ?? "?"} audio={acodec ?? "(无)"} ← {Path.GetFileName(input)}");

                    if (IsMp4SafeVideo(vcodec) && IsMp4SafeAudio(acodec))
                    {
                        string remuxArgs =
                            $"-y -i \"{input}\" -map 0:v:0 -map 0:a? -c copy -movflags +faststart \"{outPath}\"";
                        Log.D(LogKind.Media, "ffmpeg 命令行（remux）：" + FfmpegPath + " " + remuxArgs);

                        var swr = Stopwatch.StartNew();
                        var rm = await RunFfmpegAsync(remuxArgs, 120000).ConfigureAwait(false);
                        swr.Stop();

                        if (rm.exit == 0 && File.Exists(outPath) && new FileInfo(outPath).Length > 0)
                        {
                            Log.I(LogKind.Media, string.Format("remux 完成（{0}ms，不重编码）：{1:N0} 字节 → {2}",
                                swr.ElapsedMilliseconds, new FileInfo(outPath).Length, outPath));
                            return new MediaResult { ok = true, path = outPath, mime = FileTypes.MimeOf(outPath) };
                        }

                        Log.W(LogKind.Media, string.Format("remux 失败（exit={0}），回退重编码。输出尾部：{1}",
                            rm.exit, Tail(rm.stderr, 400)));
                        try { if (File.Exists(outPath)) File.Delete(outPath); } catch { }
                    }
                }

                // ---------- 重编码 ----------
                string args = isAudio
                    ? $"-y -i \"{input}\" -vn -c:a flac \"{outPath}\""
                    : $"-y -i \"{input}\" -map 0:v:0 -map 0:a? -c:v libx264 -preset ultrafast -crf 28 -c:a aac -movflags +faststart \"{outPath}\"";

                Log.I(LogKind.Media, "开始重编码：" + input + " → " + targetExt);
                Log.D(LogKind.Media, "ffmpeg 命令行：" + FfmpegPath + " " + args);

                var sw = Stopwatch.StartNew();
                var r = await RunFfmpegAsync(args, 30 * 60 * 1000).ConfigureAwait(false);
                sw.Stop();

                if (File.Exists(outPath) && new FileInfo(outPath).Length > 0)
                {
                    Log.I(LogKind.Media, string.Format("重编码完成（{0}ms，exit={1}）：{2:N0} 字节 → {3}",
                        sw.ElapsedMilliseconds, r.exit, new FileInfo(outPath).Length, outPath));
                    return new MediaResult { ok = true, path = outPath, mime = FileTypes.MimeOf(outPath) };
                }

                Log.E(LogKind.Media, string.Format("重编码失败（{0}ms，exit={1}）：{2} | ffmpeg 输出尾部：{3}",
                    sw.ElapsedMilliseconds, r.exit, input, Tail(r.stderr, 800)));

                return new MediaResult
                {
                    ok = false,
                    error = "转换失败（exit=" + r.exit + "），详见 media.log"
                };
            }
            catch (Exception ex)
            {
                Log.E(LogKind.Media, "转换异常：" + input, ex);
                return new MediaResult { ok = false, error = ex.Message };
            }
        }

        private static async Task<(int exit, string stderr)> RunFfmpegAsync(string args, int timeoutMs)
        {
            var psi = new ProcessStartInfo(FfmpegPath, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                // 必须重定向 stdin：`ffmpeg -i file`（不带输出参数）会停在交互模式等命令，
                // 不关 stdin 就会一直挂着，直到我们自己的超时把它杀掉 ——
                // 表现就是 mkv 预览卡在"准备媒体…"不动。
                RedirectStandardInput = true
            };

            using (var p = Process.Start(psi))
            {
                if (p == null) return (-1, "无法启动 ffmpeg");

                try { p.StandardInput.Close(); } catch { }   // 立刻送 EOF，让 ffmpeg 打印信息后退出

                // stdout / stderr 必须同时读走，否则管道写满会把 ffmpeg 卡死
                var errTask = p.StandardError.ReadToEndAsync();
                var outTask = p.StandardOutput.ReadToEndAsync();

                using (var cts = new CancellationTokenSource(timeoutMs))
                {
                    try { await p.WaitForExitAsync(cts.Token).ConfigureAwait(false); }
                    catch (OperationCanceledException)
                    {
                        Log.W(LogKind.Media, "ffmpeg 超时（" + timeoutMs + "ms），已强制结束");
                        try { p.Kill(true); } catch { }
                    }
                }

                string err = string.Empty;
                try { err = await errTask.ConfigureAwait(false); } catch { }
                try { await outTask.ConfigureAwait(false); } catch { }

                int code = -1;
                try { if (p.HasExited) code = p.ExitCode; } catch { }
                return (code, err);
            }
        }

        /// <summary>
        /// 从 ffmpeg 的流信息里取编码名。
        /// 输出行形如 `  Stream #0:0[0x1]: Video: h264 (High), yuv420p, 320x240 …`，
        /// 关键词不在行首，所以不能用 StartsWith —— 之前就是这么写的，
        /// 结果永远解析出 null，remux 一次都没走到，全都退化成重编码。
        /// </summary>
        private static string MatchCodec(string stderr, string kind)
        {
            if (string.IsNullOrEmpty(stderr)) return null;
            foreach (var raw in stderr.Split('\n'))
            {
                string line = raw.Trim();
                int idx = line.IndexOf(kind, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) continue;

                // 要求前面是行首或分隔符，避免命中文件名里的偶然字样
                if (idx > 0 && line[idx - 1] != ' ' && line[idx - 1] != ':') continue;

                string rest = line.Substring(idx + kind.Length).TrimStart();
                int end = rest.IndexOfAny(new[] { ' ', ',', '(', '/', '[' });
                string name = (end > 0 ? rest.Substring(0, end) : rest).Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(name)) continue;
                return name;
            }
            return null;
        }

        private static bool IsMp4SafeVideo(string codec)
        {
            if (string.IsNullOrEmpty(codec)) return false;
            return Array.IndexOf(Mp4VideoCodecs, codec) >= 0;
        }

        private static bool IsMp4SafeAudio(string codec)
        {
            if (string.IsNullOrEmpty(codec)) return true;   // 无音轨也能 remux
            return Array.IndexOf(Mp4AudioCodecs, codec) >= 0;
        }

        private static string Tail(string s, int n)
        {
            if (string.IsNullOrEmpty(s)) return "(空)";
            return s.Length <= n ? s : s.Substring(s.Length - n);
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
