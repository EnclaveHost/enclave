#!/bin/bash
# qcow-allocation-nbd-stage/r1 REAL read-only allocation check of the 9001 candidate extents on the ORIGINAL qcow2 (prepared by Claude 1705;
# NOT run by Claude). Only after jobs/tests.sh passed. Unprivileged; our own qemu-nbd --read-only child on a private unix socket; no data
# byte read; compact totals only. The original must be on a READ-ONLY mount and no other process may name it (the peer's server is
# closed; if anything names the image this job REFUSES and touches nothing).
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh qcow-alloc-r1-real 512 bash qcow-allocation-nbd-stage/r1/jobs/root-real.sh
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/qcow-allocation-nbd-stage/r1/jobs/pins.sh
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
[ "$(id -u)" != 0 ] || { echo "run unprivileged"; exit 9; }
pins_ok || exit 9
[ "$(cat $P/logs/qcow-alloc-r1-tests.rc 2>/dev/null)" = 0 ] && grep -q "^## qcow-alloc-r1-tests rc=0$" $P/logs/qcow-alloc-r1-tests.out \
  || { echo "## the fixture tests have not passed"; exit 9; }
O=$S/runs/real-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $S/runs && mkdir -m 0700 $O || exit 9
python3 -I -B - "$O" <<'PY' || { echo "## preflight refused"; echo "## qcow-alloc-r1-real rc=9"; exit 9; }
import hashlib, json, os, stat, sys
O = sys.argv[1]
image = "/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2"   # = root 1702
assert not os.path.islink(image) and stat.S_ISREG(os.stat(image).st_mode)
assert os.statvfs(image).f_flag & os.ST_RDONLY, "the original's mount is not read-only"
man = open("/home/steven/.local/state/enclave-rpc-production/manifest.json", "rb").read()
assert hashlib.sha256(man).hexdigest() == "a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441"
md = json.loads(man); assert md["backings"][md["disks"]["base"]["backing"]]["discard"] == "ignore"
cov_p = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/ext4-recovery-checksum-stage/r2/runs/real-20261026T203730Z-2323458/ext4-candidate-checksums.json"
cov = open(cov_p, "rb").read(); assert hashlib.sha256(cov).hexdigest() == "70180b22ac5a905eb415caec8c8c7014cbaa8c3f6201cd577ee2d02979de9200"
ext = json.loads(cov)["map"]["extentList"]; assert len(ext) == 9001
r = sorted([e[2] * 4096, (e[2] + e[1]) * 4096] for e in ext)
assert all(r[i][0] >= r[i - 1][1] for i in range(1, len(r))), "candidate extents overlap"
assert sum(b - a for a, b in r) == 276959557 * 4096
for d in os.listdir("/proc"):                                       # nobody (VM, peer server, anything) may hold the image open
    if d.isdigit():
        try:
            assert b"base-origin.qcow2" not in open(f"/proc/{d}/cmdline", "rb").read(), f"process {d} names the original: refusing"
        except OSError:
            pass
open(os.path.join(O, "ranges.json"), "w").write(json.dumps({"ranges": r}))
open(os.path.join(O, "preflight.json"), "w").write(json.dumps({"image": image, "readOnlyMount": True, "manifestDiscard": "ignore",
     "candidateExtents": len(r), "candidateBytes": 276959557 * 4096, "coverageSha256": "70180b22ac5a905eb415caec8c8c7014cbaa8c3f6201cd577ee2d02979de9200"}))
PY
env -i PATH=/usr/bin:/bin:/usr/sbin LC_ALL=C PYTHONDONTWRITEBYTECODE=1 timeout -k 60 8000 python3 -I -B $S/alloc_check.py \
  --image /home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2 \
  --ranges $O/ranges.json --run-dir $O --qemu-nbd /usr/sbin/qemu-nbd --qemu-nbd-sha256 $QNBD_SHA --timeout 7200 < /dev/null; rc=$?
echo "## outputs $O"; echo "## qcow-alloc-r1-real rc=$rc (0 result written; 3 refused; 4 cleanup/identity problem: STOP)"; exit $rc
