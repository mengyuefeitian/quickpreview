using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace QuickPreview
{
    /// <summary>
    /// 暴露给 Web 预览引擎的宿主对象：WebView2 中会挂到 window.QP，
    /// 异步方法自动转为 JS Promise。
    /// </summary>
    [ComVisible(true)]
    public class QPBridge
    {
        private readonly MainForm _form;

        public QPBridge(MainForm form)
        {
            _form = form;
        }

        public Task<string> PrepareMediaAsync(string path) => _form.PrepareMediaAsync(path);

        /// <summary>
        /// 读取本地文件内容并以 base64 返回（JSON 字符串）。
        /// 这是图片 / 文本 / PDF / 办公文档的预览主通道，不依赖 HTTP 拦截。
        /// </summary>
        public Task<string> ReadFileAsync(string path) => _form.ReadFileAsync(path);

        public void ShowInFolder(string path) => _form.ShowInFolder(path);

        public string Version => AppVersion.Current;
    }
}
