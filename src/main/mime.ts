// 主进程侧 mime 工具：纯实现已下沉到 shared/mime，此处仅做转发，
// 保证既有 `import ... from './mime'` 不受影响。
export * from '../shared/mime';
export type { Category } from '../shared/mime';
