# -*- coding: utf-8 -*-
"""大压缩包「只读中央目录」路径验证（不需要真实浏览器）。

用法：
    python test-samples/dev_zip_range_test.py

验什么：
  1. 用区间读取（模拟宿主 __local 的 r=start-end）解析中央目录，与 Python zipfile 逐项对照；
  2. 真正超过 4MB 分片边界的中央目录（ZIP64 + 6 万多条目）也能完整读出；
  3. 单个条目按区间取数据 + DecompressionStream 解压，内容与原始字节一致；
  4. 1.5GB 的稀疏包：EOCD 在 1.5GB 偏移处，目录/条目照常解析 ——
     这条对应「预览 1.5GB 压缩包直接闪退」，证明新路径完全不整包读取。

为什么要造稀疏文件：
  真写 1.5GB 既慢又占盘。ZIP 结构里「数据区」和「中央目录」是分开的，
  只要目录写在 1.5GB 偏移处、本地头写在 0 偏移，解析器就完全不需要读中间的空洞。
  NTFS 支持写到 EOF 之后（中间是未分配区间，读出来是 0），所以磁盘占用只有几 KB。
"""
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import shutil
import tempfile
import zipfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join("test-samples", "ziprange_entry.ts")
BUNDLE = os.path.join("test-samples", ".ziprange_bundle.cjs")
RUNNER = os.path.join("test-samples", ".ziprange_run.cjs")

RUNNER_SRC = r"""
const fs = require('fs');
require('./.ziprange_bundle.cjs');
const { readZipDirectoryByRange, extractEntryByRange, readZipDirectory } = global.__ziprange;

const file = process.argv[2];
const total = fs.statSync(file).size;
const fd = fs.openSync(file, 'r');

// 模拟宿主：只允许按区间读，且单次不得超过 4MB（与 RANGE_CHUNK 一致）
let maxChunk = 0;
const read = async (start, end) => {
  const n = end - start + 1;
  if (n <= 0) return new Uint8Array(0);
  maxChunk = Math.max(maxChunk, n);
  const buf = Buffer.allocUnsafe(n);
  let got = 0;
  while (got < n) {
    const r = fs.readSync(fd, buf, got, n - got, start + got);
    if (r <= 0) break;
    got += r;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, got);
};

(async () => {
  const out = { ok: false, total, maxChunk: 0, entries: [], extract: null, error: '' };
  try {
    const dir = await readZipDirectoryByRange(total, read);
    out.zip64 = dir.zip64;
    out.entries = dir.entries.map((e) => ({
      path: e.path, dir: e.dir, size: e.size, compressed: e.compressed,
      method: e.method, encrypted: e.encrypted, offset: e.offset
    }));
    const target = out.entries.find((e) => !e.dir && e.method === 8)
      || out.entries.find((e) => !e.dir);
    if (target) {
      const ab = await extractEntryByRange(
        { ...target, date: null },
        read
      );
      const buf = Buffer.from(ab);
      out.extract = {
        path: target.path,
        bytes: buf.length,
        sha256: require('crypto').createHash('sha256').update(buf).digest('hex'),
        head: buf.slice(0, 40).toString('utf8')
      };
    }
    out.maxChunk = maxChunk;
    out.ok = true;
  } catch (e) {
    out.error = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);
  }
  fs.closeSync(fd);
  console.log(JSON.stringify(out));
})();
"""


def run_js(path):
    r = subprocess.run(["node", RUNNER, path], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("node 运行失败：" + (r.stderr or "")[-800:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def bundle():
    r = subprocess.run(
        ["npx", "esbuild", ENTRY, "--bundle", "--format=cjs", "--platform=node", "--outfile=" + BUNDLE],
        cwd=ROOT, capture_output=True, text=True, shell=True
    )
    if r.returncode != 0:
        raise RuntimeError("esbuild 失败：" + r.stderr[-800:])


def build_multi(path):
    """普通包：一个存储条目 + 一个 deflate 条目 + 一个 12MB 大条目（跨分片）。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("hello.txt", "hello 你好\n")
        z.writestr("nested/dir/data.json", json.dumps({"a": 1, "b": [1, 2, 3]}, ensure_ascii=False))
        with z.open("big-zeros.bin", "w") as f:
            f.write(b"\0" * (12 * 1024 * 1024))
    return path


def build_many(path, count=70000):
    """65000+ 条目：迫使 ZIP64 结尾记录出现，并且中央目录 > 4MB（跨分片）。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(count):
            z.writestr("entry-%06d-with-a-long-enough-name-to-grow-the-directory.txt" % i, "")
    return path


def build_sparse(path, total=1_610_612_736):
    """1.5GiB 稀疏包：本地头在 0，中央目录 + EOCD 在文件末尾。"""
    name = b"big-entry.txt"
    payload = b"quickpreview-sparse-ok" * 8
    crc = zlib.crc32(payload)
    # 真做一次 deflate-raw：这样解压路径（DecompressionStream）也会被走到，
    # 不是只测目录解析
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = co.compress(payload) + co.flush()

    local = struct.pack(
        "<IHHHHHIIIHH", 0x04034B50, 20, 0, 8, 0, 0,
        crc, len(packed), len(payload), len(name), 0
    ) + name
    local += packed

    cd_entry = struct.pack(
        "<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 8, 0, 0,
        crc, len(packed), len(payload), len(name), 0, 0, 0, 0, 0, 0
    ) + name
    cd_offset = total - len(cd_entry) - 22
    eocd = struct.pack(
        "<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(cd_entry), cd_offset, 0
    )

    with open(path, "wb") as f:
        f.write(local)
        f.seek(cd_offset)
        f.write(cd_entry)
        f.write(eocd)
    return path


def py_entries(path):
    with zipfile.ZipFile(path) as z:
        return [i for i in z.infolist() if not i.is_dir()]


def check(path, label, expect_extract=True, sparse=False):
    print("=" * 72)
    print("%s  (%.2f MB)" % (label, os.path.getsize(path) / 1048576))
    fails = []

    def want(cond, text, detail=""):
        print("  [%s] %s%s" % ("PASS" if cond else "FAIL", text, (" — " + detail) if detail else ""))
        if not cond:
            fails.append(text)

    js = run_js(path)
    want(js["ok"], "区间解析成功", js.get("error", ""))
    if not js["ok"]:
        return fails

    with zipfile.ZipFile(path) as z:
        pins = [i for i in z.infolist() if not i.is_dir()]
        # 稀疏包只有一个条目；multi/many 也用同一套对照
        pnames = [i.filename for i in pins]
        jnames = [e["path"] for e in js["entries"]]
        pmap = {i.filename: i for i in pins}

        want(len(jnames) == len(pnames), "条目数与 zipfile 一致", "%d vs %d" % (len(jnames), len(pnames)))
        want(set(jnames) == set(pnames), "文件名集合完全一致")

        size_bad = [
            (e["path"], e["size"], pmap[e["path"]].file_size)
            for e in js["entries"]
            if e["path"] in pmap and e["size"] != pmap[e["path"]].file_size
        ]
        want(not size_bad, "每个条目解压后大小一致", str(size_bad[:3]))
        want(all(e["offset"] >= 0 for e in js["entries"]), "所有条目都拿到了本地头偏移")

        if expect_extract and js.get("extract"):
            target = js["extract"]["path"]
            with zipfile.ZipFile(path) as z2:
                raw = z2.read(target)
            sha = hashlib.sha256(raw).hexdigest()
            want(js["extract"]["bytes"] == len(raw), "解压后字节数一致",
                 "%d vs %d" % (js["extract"]["bytes"], len(raw)))
            want(js["extract"]["sha256"] == sha, "解压后内容与原文一致（sha256）", target)

    want(js["maxChunk"] <= 4 * 1024 * 1024, "单次区间读取未超过 4MB",
         "%d 字节" % js["maxChunk"])

    if sparse:
        want(js["total"] >= 1.5 * 1024 ** 3, "文件确实是 1.5GB 量级", "%d 字节（%.2f GB）"
             % (js["total"], js["total"] / 1024 ** 3))
    return fails


def main():
    bundle()
    with open(RUNNER, "w", encoding="utf-8") as f:
        f.write(RUNNER_SRC)

    tmp = tempfile.mkdtemp(prefix="qpzip_")
    total = 0
    fails = []

    sample = os.path.join(ROOT, "test-samples", "sample.zip")
    if os.path.exists(sample):
        fails += check(sample, "sample.zip（内置样本）")

    multi = build_multi(os.path.join(tmp, "multi.zip"))
    fails += check(multi, "multi.zip（含 12MB 条目，跨分片解压）")

    many = build_many(os.path.join(tmp, "many.zip"))
    fails += check(many, "many.zip（70000 条目，ZIP64 + 跨分片目录）", expect_extract=False)

    big = build_sparse(os.path.join(tmp, "big_sparse.zip"))
    fails += check(big, "big_sparse.zip（1.5GB 稀疏包）", sparse=True)

    print("=" * 72)
    for p in (multi, many, big):
        total += os.path.getsize(p)
    print("生成样本合计 %.1f MB" % (total / 1048576))
    shutil.rmtree(tmp, ignore_errors=True)
    print("失败项：%d" % len(fails))
    for f in fails:
        print("  -", f)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
