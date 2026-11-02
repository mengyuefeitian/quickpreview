# -*- coding: utf-8 -*-
"""生成最小 RAR 样本（RAR4 / RAR5 各一个，都是「存储」方式）。

用途：真实样本里全是 RAR5+压缩条目，覆盖不到
  · RAR4 老格式的头部布局（固定宽度字段、LHD_LARGE、GBK 文件名）；
  · method=0（存储）条目能不能直接读出内容。
所以这里按规范手写字节造两个包，并且**先让 7z 读通**再当样本用 ——
7z 认可就说明字节布局没写错，随后我们的解析器与它对照才有意义。

用法：python test-samples/make_rar_samples.py
"""
import os
import struct
import subprocess
import zlib

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def vint(n):
    """RAR5 变长整数：LEB128，低位在前，bit7 表示还有后续。"""
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def head_crc16(body):
    """RAR4 的头部 CRC：从 TYPE 到头部末尾的 CRC32 取低 16 位。"""
    return zlib.crc32(body) & 0xFFFF


def rar4(files):
    """files: [(name_str, data_bytes, attr)]，attr 用 Windows 属性值（0x20 文件 / 0x10 目录）。"""
    out = bytearray(b"Rar!\x1a\x07\x00")

    # MAIN_HEAD：13 字节（7 基础 + HighPosAV 2 + PosAV 4）
    # flags 0x0010 = MHD_NEWNUMBERING：表示用 RAR 2.0 的文件头布局（带 ATTR）。
    # 不写这一位，7z 会按 RAR 1.5 的旧头结构解析，后面的 FILE_HEAD 全部错位。
    body = struct.pack("<BHH", 0x73, 0x0010, 13) + struct.pack("<HI", 0, 0)
    out += struct.pack("<H", head_crc16(body)) + body

    for name, data, attr in files:
        name_b = name.encode("gbk")
        if attr & 0x10:
            pack_size, unp_size, crc = 0, 0, 0
        else:
            pack_size = unp_size = len(data)
            crc = zlib.crc32(data) & 0xFFFFFFFF
        ftime = 0  # 不写时间，解析器应给出 null
        fields = struct.pack(
            "<IIBIIBBHI",
            pack_size, unp_size, 2,          # PACK_SIZE UNP_SIZE HOST_OS(2=Windows)
            crc, ftime, 20, 0x30,            # FILE_CRC FTIME UNP_VER METHOD(0x30=存储)
            len(name_b), attr                # NAME_SIZE ATTR
        ) + name_b
        # HEAD_SIZE 是从块起点（含 CRC 2 字节）算到头部末尾的整头长度。
        # 这里不置 LONG_BLOCK(0x8000)，也就不写 ADD_SIZE —— 数据位置由 PACK_SIZE 给出。
        # （带 ADD_SIZE 的写法 7z 不接受，本机没有 WinRAR 可对照，故样本走这一种。）
        head_size = 7 + len(fields)
        body = struct.pack("<BHH", 0x74, 0x0000, head_size) + fields
        out += struct.pack("<H", head_crc16(body)) + body
        if not (attr & 0x10):
            out += data

    # ENDARC_HEAD
    body = struct.pack("<BHH", 0x7B, 0x0000, 7)
    out += struct.pack("<H", head_crc16(body)) + body
    return bytes(out)


def rar5(files, method=0):
    """files: [(name_str, data_bytes, attr)]；method 非 0 时数据是占位（只用于测"锁住"提示）。"""
    out = bytearray(b"Rar!\x1a\x07\x01\x00")

    # 主头：type=1, flags=0, ARCHIVE_FLAGS=0
    body = vint(1) + vint(0x00) + vint(0x00)
    out += struct.pack("<I", zlib.crc32(vint(len(body)) + body) & 0xFFFFFFFF) + vint(len(body)) + body

    for name, data, attr in files:
        name_b = name.encode("utf-8")
        is_dir = bool(attr & 0x10)
        data = b"" if is_dir else data
        file_flags = 0x04 if not is_dir else 0x00   # 0x04 = 带数据 CRC（目录不带）
        fields = bytearray()
        fields += vint(file_flags)
        fields += vint(0 if is_dir else len(data))  # UNP_SIZE
        fields += vint(attr)                        # ATTRIB
        if file_flags & 0x04:
            fields += struct.pack("<I", zlib.crc32(data) & 0xFFFFFFFF)
        fields += vint(method << 7)                 # COMP_INFO：version 0, method（0 = 存储）
        fields += vint(0)                           # HOST_OS
        fields += vint(len(name_b))
        fields += name_b

        # flags: 0x02 = 有数据区；0x01 = 有 extra area（这里不写 extra）
        body = vint(2) + vint(0x02) + vint(len(data)) + bytes(fields)
        out += struct.pack("<I", zlib.crc32(vint(len(body)) + body) & 0xFFFFFFFF) + vint(len(body)) + body
        out += data

    # 结束块：type=5，后面还有一个 END_OF_ARCHIVE flags（vint），少了它 7z 直接报 Headers Error
    body = vint(5) + vint(0x00) + vint(0x00)
    out += struct.pack("<I", zlib.crc32(vint(len(body)) + body) & 0xFFFFFFFF) + vint(len(body)) + body
    return bytes(out)


def check_7z(path):
    try:
        r = subprocess.run(["7z.exe", "l", "-slt", path], capture_output=True)
    except Exception:
        return "（本机没有 7z，跳过）"
    if r.returncode != 0:
        return "7z 读取失败：" + r.stdout.decode("gbk", errors="replace")[-300:]
    text = r.stdout.decode("gbk", errors="replace")
    names = [l[7:] for l in text.splitlines() if l.startswith("Path = ")]
    return "7z 可识别，条目 %d 个" % max(0, len(names) - 1)


def main():
    files4 = [
        ("文档", b"", 0x10),
        ("文档/说明.txt", "这是 GBK 编码的样本".encode("gbk"), 0x20),
        ("readme.txt", b"plain ascii", 0x20),
    ]
    files5 = [
        ("资料", b"", 0x10),
        ("资料/中文名.txt", "RAR5 存储方式，内容可直接读".encode("utf-8"), 0x20),
        ("data.bin", bytes(range(256)) * 4, 0x20),
    ]

    files6 = [("压缩包内文档.docx", b"\x00" * 64, 0x20)]
    samples = (
        ("qp_rar4_store.rar", rar4(files4)),
        ("qp_rar5_store.rar", rar5(files5)),
        # method=3：只为了验证"压缩条目只能列清单"的提示，数据本身是占位，不参与解压
        ("qp_rar5_packed.rar", rar5(files6, method=3)),
    )
    for name, blob in samples:
        p = os.path.join(OUT_DIR, name)
        with open(p, "wb") as f:
            f.write(blob)
        print("%s  %d 字节  %s" % (name, len(blob), check_7z(p)))


if __name__ == "__main__":
    main()
