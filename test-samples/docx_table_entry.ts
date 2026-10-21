// 仅供 dev_docx_table_test.py 使用：把 docx 分页/拆表函数暴露到 node 里。
// jsdom 没有真实布局，测试里会手动 mock getBoundingClientRect 给出高度，
// 从而确定性地验证「长表格是否按页拆开」这件事（不依赖本机显卡）。
import { splitTableByRows, cutSection } from '../src/renderer/lib/docxview';
(globalThis as any).__splitTableByRows = splitTableByRows;
(globalThis as any).__cutSection = cutSection;
