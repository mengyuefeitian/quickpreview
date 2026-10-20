// 扩展名与类型判断工具（主进程与渲染进程共用）
// 注意：C# 宿主侧有一份等价实现（dotnet/QuickPreview/FileTypes.cs），改动时需同步。

export type Category =
  | 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'video' | 'folder' | 'archive' | 'unsupported';

// jfif / jpe 都是 JPEG 的别名扩展名（有的相机/浏览器导出就用 .jfif）
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'svg', 'ico', 'avif', 'heic'];
const TEXT_EXT = [
  // 注意：csv 不在这里。它属于 office 类别，走"表格"渲染（按分隔符切成表格），
  // 放在 text 里会被当成纯文本显示，用户看不到列结构。
  'txt', 'md', 'mkd', 'markdown', 'json', 'log', 'yaml', 'yml', 'xml', 'ini',
  'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  'html', 'htm', 'sh', 'bat', 'ps1', 'sql', 'toml', 'env', 'gitignore', 'vue', 'less', 'scss'
];
const PDF_EXT = ['pdf'];
const OFFICE_EXT = ['docx', 'xlsx', 'pptx', 'xls', 'csv', 'doc', 'ppt', 'xlsm', 'pptm', 'docm'];
const AUDIO_EXT = ['mp3', 'flac', 'wav', 'ape', 'ogg', 'm4a', 'aac', 'wma'];
const VIDEO_EXT = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg'];
// 压缩包：显示内部文件清单，文本/图片类可直接在包内预览
const ARCHIVE_EXT = ['zip'];

// 浏览器（Chromium）可直接播放的音频/视频容器+编码
const AUDIO_PLAYABLE = ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'];
const VIDEO_PLAYABLE = ['mp4', 'webm', 'mov', 'm4v'];

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  jfif: 'image/jpeg', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic',
  bmp: 'image/bmp', webp: 'image/webp', tiff: 'image/tiff', tif: 'image/tiff',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  txt: 'text/plain', md: 'text/markdown', mkd: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', log: 'text/plain', csv: 'text/csv', yaml: 'text/yaml',
  yml: 'text/yaml', xml: 'application/xml', ini: 'text/plain', css: 'text/css',
  js: 'text/javascript', ts: 'text/typescript', html: 'text/html', htm: 'text/html',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4'
};

export function extOf(filePath: string): string {
  const i = filePath.lastIndexOf('.');
  if (i < 0) return '';
  return filePath.slice(i + 1).toLowerCase();
}

export function getMime(ext: string): string {
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function categoryOf(ext: string): Category {
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (PDF_EXT.includes(ext)) return 'pdf';
  if (TEXT_EXT.includes(ext)) return 'text';
  if (OFFICE_EXT.includes(ext)) return 'office';
  if (ARCHIVE_EXT.includes(ext)) return 'archive';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'unsupported';
}

export function isPreviewable(ext: string): boolean {
  return categoryOf(ext) !== 'unsupported';
}

// 是否需要 ffmpeg 转码才能播放
export function audioNeedsTranscode(ext: string): boolean {
  return AUDIO_EXT.includes(ext) && !AUDIO_PLAYABLE.includes(ext);
}
export function videoNeedsTranscode(ext: string): boolean {
  return VIDEO_EXT.includes(ext) && !VIDEO_PLAYABLE.includes(ext);
}

// 转码后的目标扩展名
export function transcodeTarget(ext: string, kind: 'audio' | 'video'): string {
  if (kind === 'audio') return 'flac'; // ape/wma 等统一转 flac（无损）
  return 'mp4'; // mkv/avi 等统一转 mp4(h264+aac)
}
