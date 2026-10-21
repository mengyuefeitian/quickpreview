using System;
using System.IO;

namespace QuickPreview
{
    /// <summary>
    /// 只读、限长的流包装，专门给 WebView2 当响应体用。
    ///
    /// 【为什么要它】
    /// 本地文件服务以前是 `File.ReadAllBytes(path)`：预览一部 2GB 的电影时，
    /// 播放器会连发多个 Range 请求，每个请求都把整个文件读进内存、再复制出一份 chunk。
    /// 两个并发请求就是 4GB，进程直接被 OOM 掉 ——
    /// 用户看到的现象就是「加载大视频很慢，点关闭预览就崩溃」。
    ///
    /// 现在改成 FileStream 定位到 Range 起点、只按需读 len 字节，
    /// 内存占用恒定在缓冲区大小（几十 KB），与文件大小无关。
    /// </summary>
    internal sealed class ByteRangeStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _length;
        private long _read;

        public ByteRangeStream(Stream inner, long length)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _length = length < 0 ? 0 : length;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _length;

        public override long Position
        {
            get => _read;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            long remain = _length - _read;
            if (remain <= 0) return 0;
            if (count > remain) count = (int)remain;
            if (count <= 0) return 0;

            int n = _inner.Read(buffer, offset, count);
            if (n > 0) _read += n;
            return n;
        }

        public override void Flush() { }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                // WebView2 读完会释放这个包装流，底层 FileStream 必须一起关掉，
                // 否则每播一次视频就漏一个文件句柄。
                try { _inner.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }
    }
}
