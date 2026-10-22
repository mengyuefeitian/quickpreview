using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace QuickPreview
{
    /// <summary>日志类别：按服务/功能拆分，每类独立文件，各自遵守同一套轮转规则。</summary>
    public enum LogKind
    {
        /// <summary>程序生命周期、托盘、自启、配置</summary>
        App,
        /// <summary>全局键盘钩子与资源管理器选中项读取</summary>
        Hook,
        /// <summary>预览窗口：打开/关闭/切换/文件类型判定</summary>
        Preview,
        /// <summary>ffmpeg 转码与本地文件服务（__local / Range）</summary>
        Media,
        /// <summary>WebView2 与 JS 桥接消息</summary>
        Web,
        /// <summary>错误集中记录（其余类别的 Error 也会在此留一份）</summary>
        Error
    }

    /// <summary>
    /// 日志系统。规则：
    /// 1) 每个类别一个文件：&lt;kind&gt;.log，位于 %LOCALAPPDATA%\QuickPreview\logs
    /// 2) 单个文件不超过 10MB，超限即轮转，保留 2 份备份（&lt;kind&gt;.1.log / &lt;kind&gt;.2.log）
    /// 3) 文件内容倒序：最新一条在最上面（批次内同样倒序写入）
    /// 4) 异步落盘，不阻塞预览/键盘钩子
    /// </summary>
    public static class Log
    {
        public const long MaxFileSize = 10L * 1024 * 1024;   // 单文件上限 10MB
        public const int MaxBackups = 2;                      // 备份数量
        private const int FlushIntervalMs = 800;              // 常规落盘间隔
        private const int MaxQueue = 20000;                   // 内存队列上限（防止异常刷屏撑爆内存）

        public static readonly string LogDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "QuickPreview", "logs");

        private static readonly Dictionary<LogKind, LogWriter> _writers = new Dictionary<LogKind, LogWriter>();
        private static readonly AutoResetEvent _wake = new AutoResetEvent(false);
        private static readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private static Task _worker;
        private static long _seq;

        /// <summary>
        /// 已 Shutdown（落盘线程停了）。之后任何 Log.xxx 都改成**同步**写盘：
        /// 退出路径上还会记错误（比如崩溃自愈），异步队列没人消费就等于日志凭空消失，
        /// 而且 _wake 已被释放，原来的 `_wake.Set()` 会抛 ObjectDisposedException ——
        /// 在异常处理里再抛异常，进程就死得不明不白了。
        /// </summary>
        private static volatile bool _stopped;

        static Log()
        {
            try { Directory.CreateDirectory(LogDir); } catch { }

            foreach (LogKind k in Enum.GetValues(typeof(LogKind)))
                _writers[k] = new LogWriter(k);

            _worker = Task.Run(WorkerLoop);
        }

        // ---------- 对外 API ----------
        public static void D(LogKind kind, string msg) => Enqueue(kind, "DEBUG", msg, null);
        public static void I(LogKind kind, string msg) => Enqueue(kind, "INFO ", msg, null);
        public static void W(LogKind kind, string msg) => Enqueue(kind, "WARN ", msg, null);

        public static void E(LogKind kind, string msg, Exception ex = null)
        {
            Enqueue(kind, "ERROR", msg, ex);
            if (kind != LogKind.Error)
                Enqueue(LogKind.Error, "ERROR", "[" + kind + "] " + msg, ex);
        }

        /// <summary>立即落盘（退出前调用）。可重复调用，只有第一次生效。</summary>
        public static void Shutdown()
        {
            if (_stopped) return;
            _stopped = true;
            try
            {
                _cts.Cancel();
                _wake.Set();
                if (_worker != null) _worker.Wait(1500);
                FlushAll();
                _wake?.Dispose();
                _cts?.Dispose();
            }
            catch { }
        }

        public static void FlushAll()
        {
            foreach (var w in _writers.Values) w.Flush();
        }

        /// <summary>当前文件路径。backupIndex：0=当前，1/2=备份。</summary>
        public static string PathOf(LogKind kind, int backupIndex = 0)
        {
            string name = kind.ToString().ToLowerInvariant();
            string file = backupIndex == 0 ? name + ".log" : name + "." + backupIndex + ".log";
            return Path.Combine(LogDir, file);
        }

        /// <summary>该类别的所有文件（当前 + 备份，按新旧排序）。</summary>
        public static List<string> FilesOf(LogKind kind)
        {
            var list = new List<string>();
            for (int i = 0; i <= MaxBackups; i++)
            {
                string p = PathOf(kind, i);
                if (File.Exists(p)) list.Add(p);
            }
            return list;
        }

        public static List<string> AllFiles()
        {
            var list = new List<string>();
            foreach (LogKind k in Enum.GetValues(typeof(LogKind)))
                list.AddRange(FilesOf(k));
            return list;
        }

        /// <summary>清空某类别（当前 + 备份）。</summary>
        public static void Clear(LogKind kind)
        {
            var w = _writers[kind];
            w.Drop();
            for (int i = 0; i <= MaxBackups; i++)
            {
                try { File.Delete(PathOf(kind, i)); } catch { }
            }
            I(LogKind.App, "已清空日志：" + kind);
            w.Flush();
        }

        /// <summary>打包全部日志为 zip，返回文件路径。</summary>
        public static string ExportZip(string targetDir)
        {
            Directory.CreateDirectory(targetDir);
            FlushAll();
            string dst = Path.Combine(targetDir,
                "QuickPreview-logs-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip");

            if (File.Exists(dst)) File.Delete(dst);
            using (var zip = ZipFile.Open(dst, ZipArchiveMode.Create))
            {
                foreach (var f in AllFiles())
                {
                    try
                    {
                        zip.CreateEntryFromFile(f, Path.GetFileName(f), CompressionLevel.Optimal);
                    }
                    catch { }
                }
            }
            return dst;
        }

        // ---------- 内部 ----------
        private static void Enqueue(LogKind kind, string level, string msg, Exception ex)
        {
            var w = _writers[kind];
            string text = msg ?? string.Empty;
            if (ex != null)
            {
                text += " | " + ex.GetType().Name + ": " + ex.Message;
                if (ex.StackTrace != null)
                    text += " | " + ex.StackTrace.Replace(Environment.NewLine, " ");
            }
            w.Enqueue(level, text);

            // 已停写（正在退出 / 崩溃自愈中）：同步落盘，保证这条一定留在文件里
            if (_stopped)
            {
                try { w.Flush(); } catch { }
                return;
            }

            // 错误立即唤醒落盘线程，避免进程崩溃时丢失
            if (level == "ERROR")
            {
                try { _wake.Set(); } catch { }
            }
        }

        private static void WorkerLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                try { _wake.WaitOne(FlushIntervalMs); }
                catch { break; }

                if (_cts.IsCancellationRequested) break;
                FlushAll();
            }
            FlushAll();
        }

        // ---------- 单个日志文件的写入器 ----------
        private sealed class LogWriter
        {
            private readonly LogKind _kind;
            private readonly object _lock = new object();
            private readonly List<Entry> _pending = new List<Entry>();

            public LogWriter(LogKind kind) { _kind = kind; }

            public void Enqueue(string level, string text)
            {
                lock (_lock)
                {
                    if (_pending.Count >= MaxQueue)
                        _pending.RemoveRange(0, _pending.Count / 2);   // 丢弃最旧的一半
                    _pending.Add(new Entry(level, text));
                }
            }

            public void Drop()
            {
                lock (_lock) _pending.Clear();
            }

            public void Flush()
            {
                List<Entry> batch;
                lock (_lock)
                {
                    if (_pending.Count == 0) return;
                    batch = new List<Entry>(_pending);
                    _pending.Clear();
                }

                try
                {
                    // 批次内倒序：最新的排在最前
                    batch.Reverse();
                    var sb = new StringBuilder();
                    foreach (var e in batch) sb.Append(e.Line(_kind)).Append(Environment.NewLine);
                    byte[] block = Encoding.UTF8.GetBytes(sb.ToString());

                    WriteBlock(block);
                }
                catch { }
            }

            private void WriteBlock(byte[] block)
            {
                string path = PathOf(_kind, 0);
                long existing = 0;
                try { existing = File.Exists(path) ? new FileInfo(path).Length : 0; } catch { }

                // 超限 → 轮转：当前 → .1，.1 → .2，旧 .2 删除
                if (existing + block.Length > MaxFileSize)
                {
                    Rotate();
                    existing = 0;
                }

                string tmp = path + ".tmp";
                try
                {
                    using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        fs.Write(block, 0, block.Length);
                        if (existing > 0)
                        {
                            using (var src = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                                src.CopyTo(fs, 1 << 16);
                        }
                    }
                    File.Move(tmp, path, true);
                }
                catch
                {
                    // 落盘失败（文件被占用等）：记一条提示，下个周期继续
                    lock (_lock)
                        _pending.Add(new Entry("ERROR",
                            "日志落盘失败，本批次约 " + block.Length + " 字节未能写入"));
                }
            }

            private void Rotate()
            {
                try
                {
                    for (int i = MaxBackups; i >= 1; i--)
                    {
                        string from = i == 1 ? PathOf(_kind, 0) : PathOf(_kind, i - 1);
                        string to = PathOf(_kind, i);
                        if (!File.Exists(from)) continue;
                        if (File.Exists(to)) File.Delete(to);
                        File.Move(from, to);
                    }
                }
                catch { }
            }

            private struct Entry
            {
                private readonly string _level;
                private readonly string _text;
                private readonly DateTime _time;
                private readonly int _tid;
                private readonly long _no;

                public Entry(string level, string text)
                {
                    _level = level;
                    _text = (text ?? string.Empty).Replace("\r", " ").Replace("\n", " ⏎ ");
                    _time = DateTime.Now;
                    _tid = Thread.CurrentThread.ManagedThreadId;
                    _no = Interlocked.Increment(ref _seq);
                }

                public string Line(LogKind kind)
                {
                    return string.Format("{0:yyyy-MM-dd HH:mm:ss.fff} | #{1,-6} | {2} | tid:{3,-3} | {4} | {5}",
                        _time, _no, _level, _tid, kind, _text);
                }
            }
        }
    }
}
