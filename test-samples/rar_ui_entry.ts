// 仅供 dev_rar_ui_test.py 使用：把压缩包清单界面暴露到 node 里，
// 用 jsdom 验证 RAR 的渲染结果（本机无显卡，WebView2 一解码就崩）。
import { renderZipView, bufferRarSource } from '../src/renderer/lib/zip';
(globalThis as any).__archive = { renderZipView, bufferRarSource };
