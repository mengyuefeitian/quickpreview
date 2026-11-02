// 仅供 dev_rar_test.py 使用：把 RAR 结构解析暴露到 node 里跑。
// 本机无显卡，WebView2 一解码就崩，所以纯结构解析必须在 node 侧验证。
import * as rardir from '../src/renderer/lib/rardir';
(globalThis as any).__rardir = rardir;
