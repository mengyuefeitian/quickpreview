// 仅供 dev_pdf_pass_test.py 使用：把密码提示层暴露给 jsdom。
import { createPasswordPrompt } from '../src/renderer/lib/pdfpass';

(globalThis as any).__pdfpass = { createPasswordPrompt };
