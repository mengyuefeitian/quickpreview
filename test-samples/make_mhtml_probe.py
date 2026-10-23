# -*- coding: utf-8 -*-
"""生成几个不同体积 / 不同引用形态的 mhtml，用于定位"多大的存档会把浏览器进程压崩"。

用法：python test-samples/make_mhtml_probe.py
输出目录：%TEMP%\\qp_mhtml_probe\\
"""
import base64
import os
import tempfile

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)
BOUNDARY = "----QPProbeBoundary"


def make_mhtml(html, extra_parts, cte="quoted-printable"):
    import quopri
    chunks = [b"MIME-Version: 1.0",
              ('Content-Type: multipart/related; type="text/html"; boundary="%s"'
               % BOUNDARY).encode(),
              b"", b""]
    parts = [(['Content-Type: text/html; charset="utf-8"'], html.encode("utf-8"), cte)]
    parts += extra_parts
    for hdrs, payload, enc in parts:
        out = [h.encode() for h in hdrs]
        out.append(("Content-Transfer-Encoding: " + enc).encode())
        body = base64.encodebytes(payload) if enc == "base64" else quopri.encodestring(payload)
        chunks.append(("--" + BOUNDARY).encode())
        chunks.append(b"\r\n".join(out) + b"\r\n\r\n" + body)
        chunks.append(b"")
    chunks.append(("--%s--" % BOUNDARY).encode())
    chunks.append(b"")
    return b"\r\n".join(chunks)


def main():
    d = os.path.join(tempfile.gettempdir(), "qp_mhtml_probe")
    os.makedirs(d, exist_ok=True)
    made = []

    def save(name, blob):
        p = os.path.join(d, name)
        with open(p, "wb") as f:
            f.write(blob)
        made.append((p, len(blob)))

    # ① 极小：纯文本 HTML，无任何资源
    save("tiny_plain.mhtml", make_mhtml(
        "<!DOCTYPE html><html><head><title>tiny</title></head><body><p>hello</p></body></html>", []))

    # ② 小：一张 1px png（cid）
    save("tiny_img.mhtml", make_mhtml(
        '<!DOCTYPE html><html><head><title>tiny img</title></head>'
        '<body><img src="cid:i1"><p>hi</p></body></html>',
        [(['Content-Type: image/png', 'Content-ID: <i1>'], PNG_1PX, "base64")]))

    # ③ 中：20 张图（每张 ~30KB 随机字节伪装成 png）
    big = os.urandom(30000)
    parts = [(['Content-Type: image/png', 'Content-ID: <i%d>' % i], big, "base64") for i in range(20)]
    imgs = "".join('<img src="cid:i%d">' % i for i in range(20))
    save("mid_20img.mhtml", make_mhtml(
        "<!DOCTYPE html><html><head><title>mid</title></head><body>%s</body></html>" % imgs, parts))

    for p, n in made:
        print("%-22s %8.1f KB  %s" % (os.path.basename(p), n / 1024.0, p))


if __name__ == "__main__":
    main()
