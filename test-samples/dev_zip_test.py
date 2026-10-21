# -*- coding: utf-8 -*-
"""ZIP 预览渲染验证（不需要真实浏览器）。

用法：
    python test-samples/dev_zip_test.py                  # 测内置样本
    python test-samples/dev_zip_test.py <a.zip> <b.zip>  # 测指定压缩包

做什么：
  把 src/renderer/lib/zip.ts 用 esbuild 打成 CJS，在 jsdom 里真实渲染一遍，
  检查清单行数、加密/锁定标记、顶部提示、点击条目后的面板内容，
  并与 Python zipfile 的解析结果逐项对照（名字 + 大小）。

为什么这么绕：
  本机没有显卡也没有音频设备，WebView2 一解码就崩（GpuProcessExited exitCode=7
  → BrowserProcessExited），根本没法在真实浏览器里跑。jsdom 里能验证 DOM 逻辑，
  缺的只有 URL.createObjectURL（图片预览），那个在真机上有。
"""
import json
import os
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join("test-samples", "zip_entry.ts")
BUNDLE = os.path.join("test-samples", ".zip_bundle.cjs")
RUNNER = os.path.join("test-samples", ".zip_run.cjs")

RUNNER_SRC = r"""
const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.URL = dom.window.URL;
global.Blob = dom.window.Blob;
require('./.zip_bundle.cjs');
const render = global.__renderZipView;

const toAb = (f) => {
  const b = fs.readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

async function probe(file) {
  const body = document.createElement('div');
  const bar = document.createElement('div');
  const out = { file: file, ok: false, rows: 0, locked: 0, notice: '', names: [], click: '' };
  try {
    await render(toAb(file), file.split(/[\\/]/).pop(), body, bar, { stale: () => false });
  } catch (e) {
    out.error = e.message;
    return out;
  }
  const notice = body.querySelector('.zip-notice');
  out.notice = notice ? notice.textContent.trim() : '';
  const rows = Array.from(body.querySelectorAll('.zip-row'));
  out.rows = rows.length;
  out.names = rows.map((r) => r.children[0].textContent.trim());
  out.locked = out.names.filter((n) => n.startsWith('\u{1F512}')).length;
  out.ok = true;

  // 点第一个条目，看面板说什么（加密包应给原因，普通包应给内容）
  if (rows.length) {
    rows[0].click();
    await new Promise((r) => setTimeout(r, 250));
    const panel = body.querySelector('.zip-preview');
    out.click = panel ? panel.textContent.trim() : '';
  }
  return out;
}

(async () => {
  const res = [];
  for (const f of process.argv.slice(2)) res.push(await probe(f));
  console.log(JSON.stringify(res));
})();
"""


def make_samples(d):
    """造几类边界样本：中文名、目录条目、存储模式、带注释。"""
    paths = []

    p = os.path.join(d, "qp_zip_cn.zip")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("中文文件.txt", "你好世界")
        z.writestr("子目录/", "")
        z.writestr("子目录/深层/嵌套.txt", "nested")
    paths.append(p)

    p = os.path.join(d, "qp_zip_store.zip")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_STORED) as z:
        z.writestr("a.txt", "A" * 100)
    paths.append(p)

    p = os.path.join(d, "qp_zip_cmt.zip")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("x.txt", "hello")
        z.comment = b"X" * 100
    paths.append(p)
    return paths


def expect_of(path):
    """用 Python zipfile 读一遍作为期望值；读不了（比如加密包）返回 None。"""
    try:
        with zipfile.ZipFile(path) as z:
            return [i.filename for i in z.infolist() if not i.is_dir()]
    except Exception:
        return None


def main():
    targets = [os.path.abspath(a) for a in sys.argv[1:]]
    if not targets:
        d = tempfile.mkdtemp(prefix="qpzip")
        targets = make_samples(d)
        targets.insert(0, os.path.join(ROOT, "test-samples", "sample.zip"))

    targets = [t for t in targets if os.path.exists(t)]
    if not targets:
        print("没有可测的压缩包")
        return 2

    with open(os.path.join(ROOT, RUNNER), "w", encoding="utf-8") as f:
        f.write(RUNNER_SRC)

    # Windows 下 npx 是 .cmd，必须经 shell 才能找到
    r = subprocess.run(
        "npx esbuild " + ENTRY + " --bundle --format=cjs --outfile=" + BUNDLE
        + " --platform=node --target=node18 --log-level=error",
        cwd=ROOT, capture_output=True, text=True, shell=True
    )
    if r.returncode != 0:
        print("esbuild 打包失败：\n" + (r.stderr or r.stdout)[:600])
        return 2

    r = subprocess.run(
        ["node", os.path.basename(RUNNER)] + targets,
        cwd=os.path.join(ROOT, "test-samples"),
        capture_output=True, text=True, shell=True
    )
    try:
        results = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        print("runner 输出无法解析：\n" + (r.stdout or "")[:400] + (r.stderr or "")[:400])
        return 2

    bad = 0
    for res in results:
        name = os.path.basename(res["file"])
        if not res.get("ok"):
            print("× %s → 渲染抛错：%s" % (name, res.get("error", "未知")))
            bad += 1
            continue

        exp = expect_of(res["file"])
        shown = [n.split(" ", 1)[1] if " " in n else n for n in res["names"]]
        # 清单里目录不单独成行，只比对名字能对上的部分
        match = ""
        if exp is not None:
            common = [x for x in exp if x in shown]
            match = " 与 zipfile 一致 %d/%d" % (len(common), len(exp))
            if len(common) != len(exp):
                bad += 1

        locked = res["locked"]
        tag = "（加密/不支持算法）" if locked else ""
        print("%s %s：清单 %d 行，锁定 %d 个%s%s"
              % ("×" if bad else "√", name, res["rows"], locked, tag, match))
        if res["notice"]:
            print("    提示：" + res["notice"])
        for n in res["names"][:3]:
            print("      " + n)
        if res["click"]:
            print("    点击首项 → " + res["click"][:88])

    for p in (BUNDLE, RUNNER):
        fp = os.path.join(ROOT, p)
        if os.path.exists(fp):
            os.remove(fp)

    print()
    print("全部通过" if bad == 0 else "有 %d 项异常" % bad)
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
