import { parseMhtml } from '../src/renderer/lib/mhtml';

(globalThis as any).__parseMhtml = parseMhtml;
