# -*- coding: utf-8 -*-
"""RAR 预览界面验证（jsdom，不需要浏览器）。

用法：python test-samples/dev_rar_ui_test.py

验证三件事：
  1. 清单能渲染出来，条数/名字对得上；
  2. 「存储」方式的条目点开能直接看到内容（数据偏移没错位）；
  3. 真正压缩过的条目点开要给出明确原因，而不是空面板。

样本由 make_rar_samples.py 生成（先跑它）。
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_DIR = os.path.join(ROOT, "test-samples")
ENTRY = os.path.join("test-samples", "rar_ui_entry.ts")
BUNDLE = os.path.join(TS_DIR, ".rarui_bundle.cjs")
RUNNER = os.path.join(TS_DIR, ".rarui_run.cjs")

RUNNER_SRC = r"""
const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.URL = dom.window.URL;
global.Blob = dom.window.Blob;
require('./.rarui_bundle.cjs');
const { renderZipView, bufferRarSource } = global.__archive;

const toAb = (f) => {
  const b = fs.readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

async function probe(file) {
  const body = document.createElement('div');
  const bar = document.createElement('div');
  const out = { file, ok: false };
  try {
    const src = await bufferRarSource(toAb(file), file.split(/[\\/]/).pop());
    await renderZipView(src, file.split(/[\\/]/).pop(), body, bar, { stale: () => false, format: 'rar' });
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    return out;
  }
  out.ok = true;
  out.bar = bar.textContent.trim();
  out.notice = (body.querySelector('.zip-notice') || {}).textContent || '';
  const rows = Array.from(body.querySelectorAll('.zip-row'));
  out.names = rows.map((r) => r.children[0].textContent.trim());
  out.panels = [];
  for (const r of rows) {
    r.click();
    await new Promise((res) => setTimeout(res, 200));
    const panel = body.querySelector('.zip-preview');
    out.panels.push(panel ? panel.textContent.trim() : '');
  }
  return out;
}

(async () => {
  const res = [];
  for (const f of process.argv.slice(2)) res.push(await probe(f));
  console.log(JSON.stringify(res));
})();
"""


def main():
    samples = [os.path.join(TS_DIR, n) for n in
               ("qp_rar5_store.rar", "qp_rar4_store.rar", "qp_rar5_packed.rar")]
    missing = [p for p in samples if not os.path.exists(p)]
    if missing:
        print("缺少样本，先跑：python test-samples/make_rar_samples.py")
        return 2

    with open(RUNNER, "w", encoding="utf-8") as f:
        f.write(RUNNER_SRC)

    r = subprocess.run(
        "npx esbuild " + ENTRY + " --bundle --format=cjs --outfile=" + BUNDLE
        + " --platform=node --target=node18 --log-level=error",
        cwd=ROOT, capture_output=True, text=True, shell=True
    )
    if r.returncode != 0:
        print("esbuild 打包失败：\n" + (r.stderr or r.stdout)[:600])
        return 2

    r = subprocess.run(
        ["node", os.path.basename(RUNNER)] + samples,
        cwd=TS_DIR, capture_output=True, text=True, shell=True
    )
    try:
        results = json.loads([l for l in r.stdout.strip().splitlines() if l.startswith("[")][-1])
    except Exception:
        print("runner 输出无法解析：\n" + (r.stdout or "")[:400] + (r.stderr or "")[:600])
        return 2

    bad = 0
    for res in results:
        name = os.path.basename(res["file"])
        if not res.get("ok"):
            print("× %s → 渲染抛错：%s" % (name, res.get("error")))
            bad += 1
            continue

        problems = []
        if "RAR" not in res["bar"]:
            problems.append("状态栏没显示 RAR：%r" % res["bar"])

        if name == "qp_rar5_store.rar":
            if len(res["names"]) != 2:
                problems.append("清单行数 %d，应为 2（目录不单独成行）" % len(res["names"]))
            if not any("中文名.txt" in n for n in res["names"]):
                problems.append("少了中文名条目")
            # 存储方式：内容必须真读出来
            hit = [p for p in res["panels"] if "内容可直接读" in p]
            if not hit:
                problems.append("存储条目没能读出内容，面板：%r" % (res["panels"][:1] or [""])[0][:60])

        if name == "qp_rar4_store.rar":
            if len(res["names"]) != 2:
                problems.append("清单行数 %d，应为 2" % len(res["names"]))
            if not any("说明.txt" in n for n in res["names"]):
                problems.append("GBK 文件名没解出来：%r" % res["names"])

        if name == "qp_rar5_packed.rar":
            if len(res["names"]) != 1:
                problems.append("清单行数 %d，应为 1" % len(res["names"]))
            panel = res["panels"][0] if res["panels"] else ""
            if "需解压后查看" not in panel:
                problems.append("压缩条目没给出原因，面板：%r" % panel[:70])
            if "🔒" not in res["names"][0]:
                problems.append("压缩条目没打锁标记")

        tag = "√" if not problems else "×"
        if problems:
            bad += 1
        print("%s %s：%d 行 | %s" % (tag, name, len(res["names"]), res["bar"]))
        for n in res["names"]:
            print("      " + n)
        for p in problems:
            print("    ! " + p)

    for p in (BUNDLE, RUNNER):
        if os.path.exists(p):
            os.remove(p)

    print()
    print("全部通过" if bad == 0 else "有 %d 项异常" % bad)
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
