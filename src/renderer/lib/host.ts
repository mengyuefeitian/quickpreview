// 宿主桥接层：把 C#(WebView2) 服务模式与 Electron 开发模式统一成同一套接口。

/** 是否运行在 WebView2（C# 预览服务）中 */
export const isWebView2: boolean = !!(window as any).chrome?.webview;

/**
 * 运行中的预览服务宿主（WebView2 的宿主对象，或 Electron 的 preload 桥）。
 * 注意：WebView2 的 AddHostObjectToScript 把对象挂在 chrome.webview.hostObjects 下，
 * 不会直接挂到 window 上，取错会导致 QP 为 undefined、宿主方法全部不可用。
 */
export const QP: any =
  (window as any).QP ||
  (window as any).chrome?.webview?.hostObjects?.QP ||
  (window as any).qp;

/** 渲染层 → 宿主 */
export function postToHost(msg: any): void {
  if (isWebView2) {
    (window as any).chrome.webview.postMessage(JSON.stringify(msg));
  } else if ((window as any).qp?.send) {
    (window as any).qp.send(msg);
  }
}

/** 宿主 → 渲染层（open / close 等指令） */
export function onHostMessage(cb: (msg: any) => void): void {
  if (isWebView2) {
    (window as any).chrome.webview.addEventListener('message', (e: any) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data) cb(data);
      } catch { /* 忽略非法消息 */ }
    });
  } else if ((window as any).qp?.onMessage) {
    (window as any).qp.onMessage(cb);
  }
}

// ---------- 读文件：消息往返通道 ----------
// 不走宿主对象方法调用（QP.readFileAsync 在部分环境会因 COM 参数封送失败报 0x80070057），
// 改用「页面发请求 → 宿主回消息」的方式，与已验证可用的 open/日志通道同一条链路。
type FileReply = { ok: boolean; base64?: string; error?: string };
const pendingFiles = new Map<number, (r: FileReply) => void>();
let fileSeq = 1;

onHostMessage((msg: any) => {
  if (msg && msg.type === 'fileData' && typeof msg.id === 'number') {
    const cb = pendingFiles.get(msg.id);
    if (cb) { pendingFiles.delete(msg.id); cb(msg as FileReply); }
  }
  if (msg && msg.type === 'mediaReady' && typeof msg.id === 'number') {
    const cb = pendingMedia.get(msg.id);
    if (cb) { pendingMedia.delete(msg.id); cb(msg as MediaReply); }
  }
  if (msg && msg.type === 'folderStatResult' && typeof msg.id === 'number') {
    const cb = pendingStats.get(msg.id);
    if (cb) { pendingStats.delete(msg.id); cb(msg as FolderStatReply); }
  }
});

export function requestFile(path: string, timeoutMs = 20000): Promise<FileReply> {
  return new Promise<FileReply>((resolve, reject) => {
    if (!isWebView2) { resolve({ ok: false, error: '非 WebView2 环境' }); return; }
    const id = fileSeq++;
    const timer = setTimeout(() => {
      if (pendingFiles.delete(id)) reject(new Error('读取文件超时'));
    }, timeoutMs);
    pendingFiles.set(id, (r) => { clearTimeout(timer); resolve(r); });
    postToHost({ type: 'readFile', id, path });
  });
}

// ---------- 媒体准备：消息往返通道 ----------
// 与 readFile 同理，不走宿主对象方法 QP.prepareMediaAsync（会报 0x80070057），
// 由宿主完成 ape/mkv 等格式的 ffmpeg 转码后，把可播放地址回传。
export type MediaReply = { ok: boolean; url?: string; mime?: string; error?: string };
const pendingMedia = new Map<number, (r: MediaReply) => void>();
let mediaSeq = 1;

// ---------- 文件夹统计：消息往返通道 ----------
// 递归遍历可能耗时数秒，由宿主后台线程统计（含超时截断）后回传，
// 页面先把「计算中」显示出来，拿到结果再刷新，避免一直卡在"解析中"。
export type FolderStatEntry = { name: string; size: number; dir: boolean; modified: string };
export type FolderStatReply = {
  ok: boolean; error?: string; path?: string;
  size?: number; files?: number; dirs?: number;
  truncated?: boolean; elapsedMs?: number;
  created?: string; modified?: string;
  entries?: FolderStatEntry[];
};
const pendingStats = new Map<number, (r: FolderStatReply) => void>();
let statSeq = 1;

export function requestFolderStat(path: string, timeoutMs = 30000): Promise<FolderStatReply> {
  return new Promise<FolderStatReply>((resolve, reject) => {
    if (!isWebView2) { resolve({ ok: false, error: '非 WebView2 环境' }); return; }
    const id = statSeq++;
    const timer = setTimeout(() => {
      if (pendingStats.delete(id)) reject(new Error('文件夹统计超时'));
    }, timeoutMs);
    pendingStats.set(id, (r) => { clearTimeout(timer); resolve(r); });
    postToHost({ type: 'folderStat', id, path });
  });
}

export function requestMedia(path: string, timeoutMs = 180000): Promise<MediaReply> {
  return new Promise<MediaReply>((resolve, reject) => {
    if (!isWebView2) { resolve({ ok: false, error: '非 WebView2 环境' }); return; }
    const id = mediaSeq++;
    const timer = setTimeout(() => {
      if (pendingMedia.delete(id)) reject(new Error('准备媒体超时'));
    }, timeoutMs);
    pendingMedia.set(id, (r) => { clearTimeout(timer); resolve(r); });
    postToHost({ type: 'prepareMedia', id, path });
  });
}
