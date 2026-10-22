using System;

namespace QuickPreview
{
    /// <summary>一次 HTTP 响应的区间规格。</summary>
    public struct RangeSpec
    {
        public long Start;
        public long End;
        public int Status;
        public string Reason;
        public string ContentRange;   // 200 时为 null
        public long Length;           // 实际要发的字节数
        public long AskedLength;      // 客户端"本可以"拿到的字节数（用于日志判断是否分块）
        public bool Capped;           // 是否被单次上限截断
    }

    /// <summary>
    /// Range 解析与分块（纯函数，不碰 IO / WebView2，便于单测）。
    ///
    /// 【为什么单独抽出来】
    /// 这里算错一个字节，表现就是"视频放不了 / 拖不动进度条"，而它又跑在
    /// WebView2 的资源拦截回调里 —— 出错时浏览器往往已经崩了，日志里什么都看不到。
    /// 抽成纯函数之后可以直接用命令行断言全部边界（见 test-samples/dev_range_test.py）。
    ///
    /// 【为什么要分块】
    /// Chromium 播放本地视频首包固定发 `Range: bytes=0-`（无结束位）。
    /// 照字面回整个文件，用户日志里就是：
    ///   `__local 206 xxx.mp4：Partial Content，1,975,618,907 字节（0–1,975,618,906）`
    /// WebView2 要吃下这么长的响应体，浏览器进程被打爆、连带宿主抛 SEHException 退出，
    /// 用户看到的就是「播放 mp4 直接崩溃、程序没了」。同一台机器上 325MB / 57MB / 38MB
    /// 的片子都正常，1.3GB 与 1.9GB 必崩 —— 分界线在 GB 级，与编码无关。
    /// 现在单次最多给 maxChunk 字节，剩下的浏览器会自己继续发 `Range: bytes=<end+1>-`。
    /// </summary>
    public static class FileRange
    {
        public static RangeSpec Resolve(string rangeHeader, long total, long maxChunk)
        {
            var r = new RangeSpec();

            long start = 0;
            long end = total - 1;
            int status = 200;
            string reason = "OK";
            string contentRange = null;

            if (!string.IsNullOrEmpty(rangeHeader) && rangeHeader.StartsWith("bytes="))
            {
                string spec = rangeHeader.Substring(6);
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

            long len = Math.Max(0, end - start + 1);
            r.AskedLength = len;

            // 只有 206 分片才截断：200 全量响应是页面自己 fetch 整份（docx/zip/pdf），
            // 截了就等于文件损坏。
            if (status == 206 && maxChunk > 0 && len > maxChunk)
            {
                end = start + maxChunk - 1;
                len = maxChunk;
                contentRange = $"bytes {start}-{end}/{total}";
                r.Capped = true;
            }

            r.Start = start;
            r.End = end;
            r.Status = status;
            r.Reason = reason;
            r.ContentRange = contentRange;
            r.Length = len;
            return r;
        }
    }
}
