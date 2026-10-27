// 仅供 dev_zip_range_test.py 使用：把 zipdir 的区间读取逻辑暴露到 node 里。
// 这样可以用「读本地文件」模拟区间请求，验证大压缩包不整包读取时的目录解析与条目解压。
import { readZipDirectoryByRange, extractEntryByRange, readZipDirectory } from '../src/renderer/lib/zipdir';

(globalThis as any).__ziprange = { readZipDirectoryByRange, extractEntryByRange, readZipDirectory };
