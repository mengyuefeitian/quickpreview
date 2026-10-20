using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace QuickPreview
{
    public class FolderStatResult
    {
        public bool ok;
        public string error;
        public string path;
        public long size;
        public int files;
        public int dirs;
        public bool truncated;          // 超时导致未统计完整
        public long elapsedMs;
        public DateTime created;
        public DateTime modified;
        public List<FolderEntry> entries = new List<FolderEntry>();
    }

    public class FolderEntry
    {
        public string name;
        public long size;
        public bool dir;
        public DateTime modified;
    }

    /// <summary>
    /// 文件夹统计（总大小 / 文件数 / 子目录数 / 顶层内容）。
    /// 大目录递归遍历可能很慢，因此带超时：超时即截断并标记 truncated，
    /// 保证预览窗口永远能在几秒内先出结果，而不是一直卡在"解析中"。
    /// </summary>
    public static class FolderStats
    {
        public static FolderStatResult Stat(string path, int timeoutMs = 3000, int maxEntries = 60)
        {
            var r = new FolderStatResult { path = path };
            var sw = Stopwatch.StartNew();

            try
            {
                var di = new DirectoryInfo(path);
                if (!di.Exists) { r.error = "文件夹不存在"; return r; }

                r.created = di.CreationTime;
                r.modified = di.LastWriteTime;

                // 顶层条目（立即列出，便于页面先渲染）
                foreach (var fi in di.EnumerateFiles())
                {
                    try { r.entries.Add(new FolderEntry { name = fi.Name, size = fi.Length, dir = false, modified = fi.LastWriteTime }); }
                    catch { }
                }
                foreach (var sd in di.EnumerateDirectories())
                {
                    try { r.entries.Add(new FolderEntry { name = sd.Name, size = 0, dir = true, modified = sd.LastWriteTime }); }
                    catch { }
                }
                r.entries = r.entries.OrderByDescending(e => e.dir).ThenByDescending(e => e.size)
                                     .Take(maxEntries).ToList();

                // 递归统计总大小
                var stack = new Stack<string>();
                stack.Push(path);
                while (stack.Count > 0)
                {
                    var dir = stack.Pop();
                    try
                    {
                        foreach (var f in Directory.EnumerateFiles(dir))
                        {
                            r.files++;
                            try { r.size += new FileInfo(f).Length; } catch { }

                            if (sw.ElapsedMilliseconds > timeoutMs) { r.truncated = true; break; }
                        }
                        if (r.truncated) break;

                        foreach (var d in Directory.EnumerateDirectories(dir))
                        {
                            r.dirs++;
                            stack.Push(d);
                        }
                    }
                    catch { /* 无权限目录跳过 */ }

                    if (sw.ElapsedMilliseconds > timeoutMs) { r.truncated = true; break; }
                }

                sw.Stop();
                r.elapsedMs = sw.ElapsedMilliseconds;
                r.ok = true;

                Log.I(LogKind.Preview, string.Format(
                    "文件夹统计：{0} → {1} 个文件 / {2} 个子目录 / {3}（{4}ms{5}）",
                    path, r.files, r.dirs, FormatBytes(r.size), r.elapsedMs,
                    r.truncated ? "，超时截断" : ""));
            }
            catch (Exception ex)
            {
                r.error = ex.Message;
                Log.E(LogKind.Preview, "文件夹统计失败：" + path, ex);
            }

            return r;
        }

        public static string FormatBytes(long n)
        {
            if (n < 1024) return n + " B";
            if (n < 1024 * 1024) return (n / 1024.0).ToString("F1") + " KB";
            if (n < 1024L * 1024 * 1024) return (n / 1024.0 / 1024).ToString("F1") + " MB";
            return (n / 1024.0 / 1024 / 1024).ToString("F2") + " GB";
        }
    }
}
