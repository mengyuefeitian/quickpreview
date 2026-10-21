# -*- coding: utf-8 -*-
"""轮询等待 token 的 Contents: Read and write 生效，一旦可写立即跑发布全流程。

用法：python dev_wait_and_publish.py [最长等待秒数，默认 480]
退出码：0 发布成功；1 超时（权限仍未生效）或发布失败
"""
import base64
import subprocess
import sys
import time

sys.path.insert(0, r"test-samples")
import dev_gh as g  # noqa: E402

REPO = "mengyuefeitian/quickpreview"
PROBE = "/repos/%s/contents/__probe.txt" % REPO
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 480


def can_write():
    st, _ = g.call("PUT", PROBE, {
        "message": "probe",
        "content": base64.b64encode(b"x").decode("ascii"),
    })
    if st in (200, 201):
        st2, d = g.call("GET", PROBE)
        if st2 == 200 and isinstance(d, dict) and d.get("sha"):
            g.call("DELETE", PROBE, {"message": "probe cleanup", "sha": d["sha"]})
        return True
    return False


t0 = time.time()
n = 0
while time.time() - t0 < LIMIT:
    n += 1
    ok = can_write()
    print("[%is] 探测 #%d → %s" % (int(time.time() - t0), n, "可写" if ok else "仍 403"), flush=True)
    if ok:
        print("权限已就绪，开始发布…", flush=True)
        p = subprocess.run([sys.executable, r"test-samples\dev_publish.py"],
                           capture_output=True, text=True, encoding="utf-8", errors="ignore")
        print(p.stdout, flush=True)
        if p.stderr.strip():
            print("STDERR:", p.stderr[-800:], flush=True)
        raise SystemExit(p.returncode)
    time.sleep(10)

print("TIMEOUT: %is 内仍未拿到 Contents 写权限" % int(time.time() - t0), flush=True)
raise SystemExit(1)
