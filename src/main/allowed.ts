// 本地文件访问白名单：只允许预览会话中明确的文件与转码临时文件
import * as path from 'path';

const allowedPaths = new Set<string>();

function norm(p: string): string {
  return path.normalize(p).toLowerCase();
}

export function addAllowed(p: string): void {
  allowedPaths.add(norm(p));
}

export function addAllowedMany(list: string[]): void {
  for (const p of list) addAllowed(p);
}

export function isAllowed(p: string): boolean {
  return allowedPaths.has(norm(p));
}

// 构造安全的 local:// 访问地址（通过 query 传递路径，避免 URL 解析把盘符当 host）
export function localUrl(absPath: string): string {
  return 'local://file?path=' + encodeURIComponent(absPath);
}
