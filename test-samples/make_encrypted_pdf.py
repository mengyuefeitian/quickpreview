# -*- coding: utf-8 -*-
"""生成一个真正加密的 PDF（Standard security handler, V=1 / R=2 / 40-bit RC4）。

为什么要自己写：
  本机没有 pypdf / pikepdf，装不了；而"加密 PDF 能不能弹密码框"必须有真样本才能验。
  R2 是最经典的实现（Acrobat 3 起），算法短、可逐字节对照规范，
  正好覆盖我们关心的路径：pdf.js 抛 PasswordException → onPassword 回调。

用法：
    python test-samples/make_encrypted_pdf.py <out.pdf> [user_pw] [owner_pw]
"""
import hashlib
import io
import os
import sys

# PDF 规范里的 32 字节填充串（Algorithm 2 第一步）
PAD = bytes([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
    0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
    0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
])

PERM = -4  # 0xFFFFFFFC：除"必须留 0"的位外全开


def rc4(key: bytes, data: bytes) -> bytes:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 0xFF
        s[i], s[j] = s[j], s[i]
    out = bytearray()
    i = j = 0
    for ch in data:
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        out.append(ch ^ s[(s[i] + s[j]) & 0xFF])
    return bytes(out)


def pad_pw(pw: bytes) -> bytes:
    return (pw + PAD)[:32]


def make_key(user_pw: bytes, owner_pw: bytes, doc_id: bytes) -> tuple:
    """返回 (O, U, 文件密钥)。R=2 ⇒ 密钥 5 字节。"""
    opad = pad_pw(owner_pw)
    # Algorithm 3：O = RC4(MD5(owner_padded)[:5], user_padded)
    okey = hashlib.md5(opad).digest()[:5]
    o = rc4(okey, pad_pw(user_pw))

    # Algorithm 2：key = MD5(user_padded + O + P(4B LE) + ID[0])[:5]
    h = hashlib.md5()
    h.update(pad_pw(user_pw))
    h.update(o)
    h.update((PERM & 0xFFFFFFFF).to_bytes(4, "little"))
    h.update(doc_id)
    key = h.digest()[:5]

    # Algorithm 4（R=2）：U = RC4(key, PAD)
    u = rc4(key, PAD)
    return o, u, key


def obj_key(key: bytes, num: int, gen: int = 0) -> bytes:
    h = hashlib.md5()
    h.update(key)
    h.update(num.to_bytes(3, "little"))
    h.update(gen.to_bytes(2, "little"))
    return h.digest()[: min(len(key) + 5, 16)]


def build(user_pw: str, owner_pw: str) -> bytes:
    doc_id = hashlib.md5(b"quickpreview-encrypted-sample").digest()
    o, u, key = make_key(user_pw.encode("latin-1"), owner_pw.encode("latin-1"), doc_id)

    content = b"BT /F1 24 Tf 40 120 Td (Encrypted PDF Test) Tj ET"
    enc_content = rc4(obj_key(key, 4), content)

    objs = {
        1: b"<</Type/Catalog/Pages 2 0 R>>",
        2: b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        3: b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 200]"
           b"/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
        4: b"<</Length %d>>\nstream\n" % len(enc_content) + enc_content + b"\nendstream",
        5: b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        6: b"<</Filter/Standard/V 1/R 2/Length 40/O <%s>/U <%s>/P %d>>"
           % (o.hex().encode(), u.hex().encode(), PERM),
    }

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num in sorted(objs):
        offsets[num] = out.tell()
        out.write(b"%d 0 obj\n" % num + objs[num] + b"\nendobj\n")

    xref_at = out.tell()
    size = max(objs) + 1
    out.write(b"xref\n0 %d\n" % size)
    out.write(b"0000000000 65535 f \n")
    for num in range(1, size):
        out.write(b"%010d 00000 n \n" % offsets.get(num, 0))

    out.write(
        b"trailer\n<</Size %d/Root 1 0 R/Encrypt 6 0 R/ID[<%s><%s>]>>\n"
        b"startxref\n%d\n%%%%EOF\n"
        % (size, doc_id.hex().encode(), doc_id.hex().encode(), xref_at)
    )
    return out.getvalue()


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    out = sys.argv[1]
    user = sys.argv[2] if len(sys.argv) > 2 else "123456"
    owner = sys.argv[3] if len(sys.argv) > 3 else "owner-secret"
    data = build(user, owner)
    with open(out, "wb") as f:
        f.write(data)
    print("写出 %s（%d 字节，用户密码=%r）" % (out, len(data), user))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
