// 仅供 dev_zip_test.py 使用：把 ZIP 渲染逻辑暴露到 node 里，
// 这样可以在 jsdom 中验证渲染结果，不依赖真实浏览器（本机无显卡，WebView2 会崩）。
import { renderZipView } from '../src/renderer/lib/zip';
(globalThis as any).__renderZipView = renderZipView;
