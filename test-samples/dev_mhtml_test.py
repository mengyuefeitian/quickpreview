# -*- coding: utf-8 -*-
"""MHTML / MHT 单文件网页解析验证（不需要真实浏览器）。

用法：
    python test-samples/dev_mhtml_test.py                       # 用 Downloads 里的样本
    python test-samples/dev_mhtml_test.py <a.mhtml> [b.mht]     # 测指定文件

做什么：
  把 src/renderer/lib/mhtml.ts 用 esbuild 打成 CJS，在 node 里直接跑 parseMhtml，
  再把结果与 Python 标准库 email 的解析逐项对照：
    - part 数量是否一致（boundary 切分对不对）
    - 引用的图片/CSS 是否都被换成了 data URI（cid: 不能有残留）
    - HTML 是否按 charset 正确解码（中文标题不能变乱码）
    - 内联后的 HTML 是否明显变长（说明资源真的塞进去了）

为什么要在 node 里跑：本机没有显卡，WebView2 一渲染就崩，没法在真浏览器里验；
  parseMhtml 是纯函数（不碰 DOM），单独测它最划算。iframe 渲染部分只能实机看。
"""
import base64
import email
import email.policy
import json
import os
import quopri
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join("test-samples", "mhtml_entry.ts")
BUNDLE = os.path.join("test-samples", ".mhtml_bundle.cjs")
RUNNER = os.path.join("test-samples", ".mhtml_run.cjs")

RUNNER_SRC = r"""
const fs = require('fs');
require('./.mhtml_bundle.cjs');
const parse = global.__parseMhtml;
const buf = fs.readFileSync(process.argv[2]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const r = parse(ab);
const html = r.html;
console.log(JSON.stringify({
  parts: r.stats.parts,
  inlined: r.stats.inlined,
  external: r.stats.external,
  charset: r.stats.charset,
  encoding: r.stats.encoding,
  title: r.stats.title,
  htmlLen: html.length,
  cidLeft: (html.replace(/<!--[\s\S]*?-->/g, '').match(/cid:/g) || []).length,
  dataUri: (html.match(/data:[a-z]+\/[a-z0-9.+-]+;base64,/g) || []).length,
  doctype: /<!doctype/i.test(html),
  firstChars: html.slice(0, 60)
}));
"""


def esbuild():
    env = dict(os.environ)
    cmd = ["npx", "esbuild", ENTRY, "--bundle", "--format=cjs",
           "--platform=node", "--outfile=" + BUNDLE]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, shell=True, env=env)
    if r.returncode != 0:
        print("esbuild 失败:\n" + (r.stderr or r.stdout))
        return False
    return True


def run_js(path):
    r = subprocess.run(["node", RUNNER, os.path.abspath(path)],
                       cwd=ROOT, capture_output=True, text=True, shell=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout)[:800])
    return json.loads(r.stdout.strip().splitlines()[-1])


def py_parts(path):
    """用标准库独立解析一遍：真实 part 数 + 各类资源数（作为对照）。"""
    with open(path, "rb") as f:
        msg = email.message_from_bytes(f.read(), policy=email.policy.compat32)
    leaves = [p for p in msg.walk() if not p.is_multipart()]
    html_parts = [p for p in leaves if p.get_content_type() == "text/html"]
    images = [p for p in leaves if p.get_content_type().startswith("image/")]
    css = [p for p in leaves if p.get_content_type() == "text/css"]
    return {
        "leaves": len(leaves),
        "html": len(html_parts),
        "images": len(images),
        "css": len(css),
        "root_type": msg.get_content_type(),
    }


def check(path, expect_title=None):
    name = os.path.basename(path)
    print("=" * 72)
    print(name, "(%.1f MB)" % (os.path.getsize(path) / 1048576))

    js = run_js(path)
    py = py_parts(path)
    fails = []

    def want(cond, label, detail=""):
        print("  [%s] %s%s" % ("PASS" if cond else "FAIL", label, (" — " + detail) if detail else ""))
        if not cond:
            fails.append(label)

    print("  js : parts=%d inlined=%d external=%d charset=%s enc=%s"
          % (js["parts"], js["inlined"], js["external"], js["charset"], js["encoding"]))
    print("  py : leaves=%d html=%d images=%d css=%d root=%s"
          % (py["leaves"], py["html"], py["images"], py["css"], py["root_type"]))
    print("  title: %r" % js["title"][:60])

    want(py["root_type"] == "multipart/related", "顶层是 multipart/related")
    want(js["parts"] == py["leaves"],
         "part 数量与标准库一致", "%d vs %d" % (js["parts"], py["leaves"]))
    want(js["doctype"], "解出的内容确实是 HTML（含 doctype）")
    want(js["cidLeft"] == 0, "没有残留的 cid: 引用", "剩余 %d 处" % js["cidLeft"])
    want(js["dataUri"] >= py["images"] + py["css"],
         "图片与 CSS 都换成了 data URI", "%d >= %d" % (js["dataUri"], py["images"] + py["css"]))
    # 体积断言只对大样本有意义：合成的小样本 base64 编码后反而比 HTML 本身还大
    if os.path.getsize(path) > 100_000:
        want(js["htmlLen"] > os.path.getsize(path) * 0.8,
             "内联后 HTML 体积合理", "%d 字符" % js["htmlLen"])
    want(bool(js["title"]) and "\ufffd" not in js["title"],
         "标题解码正常（无乱码）", js["title"][:40])
    if expect_title is not None:
        want(js["title"] == expect_title, "标题与原文逐字一致", js["title"][:40])
    return fails


# ---------- 合成样本：补真实文件覆盖不到的分支 ----------
# 真实样本是 quotes-printable + utf-8 + cid:，下面两组分别覆盖
# ① base64 + gb2312 中文页面 + cid: 内联；
# ② Blink 另存的那种 Content-Location 绝对地址引用。
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)


def _enc_part(headers, payload, cte):
    out = [h.encode("ascii") for h in headers]
    out.append(("Content-Transfer-Encoding: " + cte).encode("ascii"))
    body = base64.encodebytes(payload) if cte == "base64" else quopri.encodestring(payload)
    return b"\r\n".join(out) + b"\r\n\r\n" + body


def make_mhtml(parts, boundary="----QPTestBoundary"):
    chunks = [b'MIME-Version: 1.0',
              ('Content-Type: multipart/related; type="text/html"; boundary="%s"'
               % boundary).encode("ascii"),
              b"",
              b"This is a multi-part message in MIME format.",
              b""]
    for hdrs, payload, cte in parts:
        chunks.append(("--" + boundary).encode("ascii"))
        chunks.append(_enc_part(hdrs, payload, cte))
        chunks.append(b"")
    chunks.append(("--%s--" % boundary).encode("ascii"))
    chunks.append(b"")
    return b"\r\n".join(chunks)


def gen_synthetic():
    d = tempfile.mkdtemp(prefix="qp_mhtml_")
    out = []

    # ① base64 + gb2312 + cid:
    title = "中文单文件网页测试"
    html = (
        '<!DOCTYPE html><html><head><meta charset="gb2312">'
        "<title>%s</title>"
        '<link rel="stylesheet" href="cid:style001"></head>'
        '<body><h1>%s</h1><img src="cid:img001"><p>正文段落，用于验证 GBK 解码。</p></body></html>'
        % (title, title)
    )
    css = "body{font-family:sans-serif}h1{color:#c00}"
    p1 = os.path.join(d, "base64_gbk.mhtml")
    with open(p1, "wb") as f:
        f.write(make_mhtml([
            (['Content-Type: text/html; charset="gb2312"',
              'Content-ID: <html001>'], html.encode("gbk"), "base64"),
            (['Content-Type: text/css; charset="gb2312"',
              'Content-ID: <style001>'], css.encode("gbk"), "base64"),
            (['Content-Type: image/png',
              'Content-ID: <img001>'], PNG_1PX, "base64"),
        ]))
    out.append((p1, title))

    # ② quoted-printable + Content-Location 绝对地址（Blink/Chrome 另存的形态）
    title2 = "Absolute Location Page"
    base = "http://example.invalid/news/2024/0101/"
    html2 = (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>%s</title>'
        '<link rel="stylesheet" href="%sstyle.css"></head>'
        '<body><img src="%slogo.png"><p>hello world</p></body></html>'
        % (title2, base, base)
    )
    p2 = os.path.join(d, "content_location.mhtml")
    with open(p2, "wb") as f:
        f.write(make_mhtml([
            (['Content-Type: text/html; charset="utf-8"'], html2.encode("utf-8"), "quoted-printable"),
            (['Content-Type: text/css',
              'Content-Location: %sstyle.css' % base], b"body{margin:0}", "quoted-printable"),
            (['Content-Type: image/png',
              'Content-Location: %slogo.png' % base], PNG_1PX, "base64"),
        ]))
    out.append((p2, title2))

    return out



def main():
    if len(sys.argv) > 1:
        targets = sys.argv[1:]
    else:
        d = os.path.expanduser("~/Downloads")
        targets = []
        for f in sorted(os.listdir(d)):
            if f.lower().endswith((".mhtml", ".mht")):
                targets.append(os.path.join(d, f))
        if not targets:
            print("没找到 .mhtml 样本，请显式传入路径")
            return 2

    open(RUNNER, "w", encoding="utf-8").write(RUNNER_SRC)
    if not esbuild():
        return 2

    total = 0
    for t in targets:
        total += len(check(t))
    print("")
    print("—— 合成样本（覆盖真实文件里没有的编码/引用形态）——")
    for t, title in gen_synthetic():
        total += len(check(t, expect_title=title))

    print("")
    print("失败项：%d" % total)
    return 0 if total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
