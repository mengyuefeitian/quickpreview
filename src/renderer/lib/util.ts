// 本地文件地址构造（用于音视频等需要 Range 的流式场景）：
// - WebView2（C# 服务）走 https://qpfile.local/__local ，由 C# 过滤器拦截并读取本地文件。
//   注意：这里必须用与 webroot（app.local）【不同】的主机名，否则请求会被
//   SetVirtualHostNameToFolderMapping 的虚拟目录映射吞掉，返回 404 而不触发拦截。
// - Electron（开发模式）走自定义 local:// 协议
export function appLocalUrl(absPath: string): string {
  const enc = encodeURIComponent(absPath);
  if ((window as any).chrome?.webview) return 'https://qpfile.local/__local?p=' + enc;
  return 'local://file?path=' + enc;
}

export function localUrl(absPath: string): string {
  return appLocalUrl(absPath);
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 创建元素。用泛型按标签名返回具体类型，
 * 这样 el('button') 直接就是 HTMLButtonElement，可以访问 .type/.disabled 等属性。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, html?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
