// 主进程与渲染进程共享的类型定义（仅类型，无运行时代码）
import type { Category } from './mime';

export type { Category };

export interface FileItem {
  path: string;   // 绝对路径
  name: string;   // 文件名
  ext: string;    // 小写扩展名（不含点）
  category: Category;
  size: number;   // 字节
  isDir?: boolean; // 是否为文件夹（文件夹无扩展名，只能由宿主告知）
}

export interface MediaPrepareResult {
  ok: boolean;
  url?: string;
  mime?: string;
  error?: string;
}
