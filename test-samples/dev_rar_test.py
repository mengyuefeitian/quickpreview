# -*- coding: utf-8 -*-
"""RAR 结构解析验证（不需要浏览器，也不需要装 WinRAR）。

用法：
    python test-samples/dev_rar_test.py                     # 测 test-samples/*.rar
    python test-samples/dev_rar_test.py <a.rar> <b.rar>      # 测指定压缩包

做什么：
  把 src/renderer/lib/rardir.ts 用 esbuild 打成 CJS，在 node 里跑两遍：
    · 整包内存解析；
    · 区间解析（模拟宿主的 &r=start-end 通道，统计请求次数与字节数）。
  然后用 7z（NanaZip）的输出逐条对照：条目数、文件名、原始大小、压缩后大小。

为什么要对照：
  RAR5 的块头字段密集（CRC 固定 4 字节、其余是 LEB128 变长整数、HEAD_SIZE 从 type 字段起算），
  任何一处偏差都会导致后续全部错位，但"错位"不一定报错 —— 只会列出一堆乱七八糟的名字。
  所以必须拿第三方实现的结果做基准。

注意：7z 的输出是**控制台代码页（GBK）**，必须按 gbk 解码，按 utf-8 读会全是乱码。
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_DIR = os.path.join(ROOT, "test-samples")
ENTRY = os.path.join("test-samples", "rar_entry.ts")
BUNDLE = os.path.join(TS_DIR, ".rar_bundle.cjs")
RUNNER = os.path.join(TS_DIR, ".rar_run.cjs")

RUNNER_SRC = r"""
const fs = require('fs');
require('./.rar_bundle.cjs');
const rar = global.__rardir;

const toAb = (f) => {
  const b = fs.readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

// 模拟宿主的 __local 区间通道：&r=start-end，单次 206 响应。
// 同时统计请求次数与总字节数，用来证明大包没有整包读。
function makeRange(f, stat) {
  return async (start, end) => {
    stat.requests++;
    stat.bytes += end - start + 1;
    const fd = fs.openSync(f, 'r');
    try {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      return new Uint8Array(buf.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  };
}

function plain(dir) {
  return {
    format: dir.format,
    encryptedHeaders: dir.encryptedHeaders,
    truncated: dir.truncated,
    entries: dir.entries.map((e) => ({
      path: e.path,
      dir: e.dir,
      size: e.size,
      compressed: e.compressed,
      method: e.method,
      encrypted: e.encrypted,
      dataOffset: e.dataOffset,
      date: e.date ? e.date.toISOString() : null
    }))
  };
}

async function probe(file) {
  const out = { file, ok: false };
  try {
    const ab = toAb(file);
    out.mem = plain(await rar.readRarDirectory(ab));

    const total = ab.byteLength;
    const stat = { requests: 0, bytes: 0 };
    out.range = plain(await rar.readRarDirectoryByRange(total, makeRange(file, stat)));
    out.rangeStat = stat;
    out.total = total;
    out.same = JSON.stringify(out.mem.entries) === JSON.stringify(out.range.entries);
    out.ok = true;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}

(async () => {
  const res = [];
  for (const f of process.argv.slice(2)) res.push(await probe(f));
  console.log(JSON.stringify(res));
})();
"""


def find_7z():
    for cand in ("7z.exe", "7z", "7za.exe"):
        try:
            r = subprocess.run([cand, "i"], capture_output=True)
            if r.returncode in (0, 1):
                return cand
        except Exception:
            continue
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                 os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
        for sub in ("7-Zip", "NanaZip", "WinRAR"):
            for exe in ("7z.exe", "UnRAR.exe"):
                p = os.path.join(base, sub, exe)
                if os.path.exists(p):
                    return p
    return None


def list_by_7z(z7, path):
    """用 7z -slt 取期望值。返回 [(name, size, packed)]；拿不到返回 None。"""
    if not z7:
        return None
    try:
        r = subprocess.run([z7, "l", "-slt", path], capture_output=True)
    except Exception:
        return None
    if r.returncode not in (0, 1):
        return None
    text = r.stdout.decode("gbk", errors="replace")
    items = []
    cur = {}
    started = False
    for line in text.splitlines():
        # 条目列表在 "----------" 分隔线之后；之前那段是压缩包自身的属性
        if line.startswith("----------"):
            started = True
            continue
        if not started:
            continue
        if line.startswith("Path = "):
            if cur.get("Path"):
                items.append(cur)
            cur = {"Path": line[7:]}
        elif line.startswith("Size = "):
            cur["Size"] = line[7:]
        elif line.startswith("Packed Size = "):
            cur["Packed"] = line[14:]
        elif line.startswith("Folder = "):
            cur["Folder"] = line[9:]
        elif line.startswith("Attributes = "):
            cur["Attr"] = line[13:]
    if cur.get("Path"):
        items.append(cur)

    out = []
    for it in items:
        # 目录条目不参与对照：NanaZip 的 rar 插件不写 Folder 字段，只在 Attributes 里放 D
        if it.get("Folder") == "+" or "D" in it.get("Attr", ""):
            continue
        try:
            # 7z 用反斜杠分隔，比较前统一成正斜杠
            out.append((it["Path"].replace("\\", "/"), int(it.get("Size", "0")),
                        int(it.get("Packed", "0"))))
        except ValueError:
            continue
    return out or None


def main():
    targets = [os.path.abspath(a) for a in sys.argv[1:]]
    if not targets:
        targets = sorted(
            os.path.join(TS_DIR, n) for n in os.listdir(TS_DIR) if n.lower().endswith(".rar")
        )
        if not targets:
            print("test-samples 下没有 .rar 样本，直接传路径：")
            print("  python test-samples/dev_rar_test.py <某.rar>")
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
        ["node", os.path.basename(RUNNER)] + targets,
        cwd=TS_DIR, capture_output=True, text=True, shell=True
    )
    try:
        results = json.loads([l for l in r.stdout.strip().splitlines() if l.startswith("[")][-1])
    except Exception:
        print("runner 输出无法解析：\n" + (r.stdout or "")[:400] + (r.stderr or "")[:600])
        return 2

    z7 = find_7z()
    if not z7:
        print("⚠ 本机没找到 7z，只做自洽检查（无第三方对照）\n")

    bad = 0
    for res in results:
        name = os.path.basename(res["file"])
        if not res.get("ok"):
            print("× %s → 解析抛错：%s" % (name, res.get("error", "未知")))
            bad += 1
            continue

        mem = res["mem"]
        ents = mem["entries"]
        total_size = sum(e["size"] for e in ents if not e["dir"])
        st = res.get("rangeStat") or {}
        ratio = (st.get("bytes", 0) / res["total"] * 100) if res["total"] else 0

        problems = []
        if not res.get("same"):
            problems.append("区间解析结果与内存解析不一致")
        if mem["truncated"]:
            problems.append("清单被截断")

        exp = list_by_7z(z7, res["file"])
        detail = ""
        if exp is not None:
            got = [(e["path"], e["size"], e["compressed"]) for e in ents if not e["dir"]]
            if len(got) != len(exp):
                problems.append("条目数 %d ≠ 7z %d" % (len(got), len(exp)))
            exp_map = {n: (s, p) for n, s, p in exp}
            got_map = {n: (s, p) for n, s, p in got}
            miss = [n for n in exp_map if n not in got_map]
            extra = [n for n in got_map if n not in exp_map]
            if miss:
                problems.append("缺 %d 个条目（如 %s）" % (len(miss), miss[0][:40]))
            if extra:
                problems.append("多 %d 个条目（如 %s）" % (len(extra), extra[0][:40]))
            diff = [(n, exp_map[n], got_map[n]) for n in exp_map
                    if n in got_map and exp_map[n] != got_map[n]]
            if diff:
                n, a, b = diff[0]
                problems.append("大小/压缩后不符 %d 项（%s：7z %s 得 %s）" % (len(diff), n[:28], a, b))
            detail = " | 7z 对照 %d/%d" % (len(exp) - len(miss), len(exp))

        tag = "√" if not problems else "×"
        if problems:
            bad += 1
        print("%s %s" % (tag, name))
        print("    %s · %d 个文件 · 解压后 %.2f MB · 区间读 %d 次 / %.2f MB（%.1f%%）%s"
              % (mem["format"], len([e for e in ents if not e["dir"]]),
                 total_size / 1048576.0, st.get("requests", 0),
                 st.get("bytes", 0) / 1048576.0, ratio, detail))
        for e in ents[:2]:
            print("      %s（%d 字节）" % (e["path"][:56], e["size"]))
        for p in problems:
            print("    ! " + p)

        if res["total"] > 1024 * 1024 and st.get("bytes", 0) >= res["total"]:
            print("    ! 区间读取量不小于文件本身，等于整包读了")

    for p in (BUNDLE, RUNNER):
        if os.path.exists(p):
            os.remove(p)

    print()
    print("全部通过" if bad == 0 else "有 %d 项异常" % bad)
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
