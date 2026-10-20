# -*- coding: utf-8 -*-
"""
PPTX 渲染器离线校验：用 jsdom 提供 DOM，跑一遍 lib/pptx.ts，
检查「背景是否还原」「形状数量」「填充/文字是否渲染出来」。

用法：
  python test-samples/ppt_check.py <file.pptx> [<file2.pptx> ...]
不传参数时用 test-samples/sample.pptx。
"""
import os
import subprocess
import sys
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"C:\Users\anweining01\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
# 注意：node_modules/.bin/esbuild 是 shell 脚本，Python 直接 exec 会报 WinError 193，
# 必须经 node 跑 esbuild 的 JS 入口（它内部再拉起对应平台的原生二进制）
ESBUILD_PKG = os.path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild")
OUT = os.path.join(ROOT, "test-samples", "_pptx_bundle.js")

JS = r"""
const { JSDOM } = require('jsdom');
const fs = require('fs');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.HTMLElement = dom.window.HTMLElement;

const { renderPptx } = require(process.argv[2]);

(async () => {
  const files = process.argv.slice(3);
  const out = [];
  for (const f of files) {
    const ab = fs.readFileSync(f);
    const buf = ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
    try {
      const el = await renderPptx(buf, 960);
      const slides = Array.from(el.querySelectorAll('.slide'));
      out.push({
        file: f,
        ok: true,
        slides: slides.length,
        slideInfo: slides.slice(0, 3).map((s) => ({
          bg: s.style.background || s.style.backgroundColor || '',
          bgImage: (s.style.backgroundImage || '').slice(0, 40),
          shapes: s.querySelectorAll('.shape').length,
          filled: Array.from(s.querySelectorAll('.shape'))
            .filter((x) => (x.style.background || x.style.backgroundImage)).length,
          bordered: Array.from(s.querySelectorAll('.shape'))
            .filter((x) => x.style.border).length,
          texts: Array.from(s.querySelectorAll('.shape span'))
            .map((x) => x.textContent).filter((t) => t && t.trim()).slice(0, 6),
          tables: s.querySelectorAll('table').length,
          images: Array.from(s.querySelectorAll('.shape'))
            .filter((x) => x.style.backgroundImage).length
        }))
      });
    } catch (e) {
      out.push({ file: f, ok: false, error: (e && e.stack) || String(e) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
})();
"""


def main():
    files = sys.argv[1:] or [os.path.join(ROOT, "test-samples", "sample.pptx")]
    subprocess.run(
        [NODE, ESBUILD_PKG, os.path.join(ROOT, "src", "renderer", "lib", "pptx.ts"),
         "--bundle", "--format=cjs", "--platform=node", "--outfile=" + OUT],
        cwd=ROOT, check=True, capture_output=True)

    runner = os.path.join(ROOT, "test-samples", "_pptx_run.cjs")
    with open(runner, "w", encoding="utf-8") as fh:
        fh.write(JS)
    r = subprocess.run([NODE, runner, OUT] + files, cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8")
    print(r.stdout or "")
    if r.stderr:
        print("STDERR:", r.stderr[:2000], file=sys.stderr)


if __name__ == "__main__":
    main()
