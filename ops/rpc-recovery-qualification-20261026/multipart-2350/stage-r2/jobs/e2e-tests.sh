#!/bin/bash
# recovery-multipart-stage/r2 END-TO-END tests with the frozen r9 overlay session (PREPARED by Claude 1748; NOT run by Claude). Root:
#   bash jobs/q-exit-status.sh rmp-r2-e2e 1024 bash recovery-multipart-stage/r2/jobs/e2e-tests.sh
# NOT under unshare (FUSE mounts need the host fusermount3), as the owner (never root), like r9's own tests. Uses r9's guards (stage
# SHA256SUMS, the pinned qemu-img/qemu-io/qemu-nbd/nbdfuse and fuse2fs, /dev/fuse). Only r9's own fixture images under this run dir;
# never the original, the journal copy, a device, a VM or USB. Peers' mounts/processes must be identical before and after.
# PASS only if: exactly "Ran 6 tests", last line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, no mount
# of this run left, peers unchanged, both stages unchanged.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh   # r9 pins + guards()
guards
M=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); N=6
(cd "$M" && sha256sum -c --quiet SHA256SUMS) || die "multipart r2 != SHA256SUMS"
[ "$(sha256sum < $S/SHA256SUMS | cut -c1-64)" = 17b5528fc122203708dc3cce1ddfdf4e3151ff02ec21d09b55cd651fbcd103b3 ] || die "r9 SUMS pin"
[ -z "$(find "$M" -path "$M/runs" -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || die "bytecode in stage"
[ "$(df --output=avail -B1 "$M" | tail -1)" -ge $((2 << 30)) ] || die "less than 2 GiB free for the fixtures"
O=$M/runs/e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$M/runs" && chmod 0700 "$M/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$O/work" || die "run dir"
peer_snapshot > "$O/peers-before.txt"
env -i PATH=$PATH LC_ALL=C MULTIPART_E2E_WORK="$O/work" MULTIPART_FUSE2FS=$FUSE2FS MULTIPART_FUSE2FS_SHA256=$FUSE2FS_SHA \
  timeout -k 10 3600 python3 -I -B -u -W always::ResourceWarning "$M/tests/test_e2e.py" > "$O/stdout.txt" 2> "$O/stderr.txt"; r=$?
peer_snapshot > "$O/peers-after.txt"
python3 -I -B - "$O" "$r" "$M" "$N" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, r, M, n = pathlib.Path(sys.argv[1]), int(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
out, err = (O / "stdout.txt").read_text(errors="replace"), (O / "stderr.txt").read_text(errors="replace")
lines = [l for l in err.splitlines() if l.strip()]
ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
mounts = [l for l in open("/proc/self/mountinfo").read().splitlines() if str(O) in l]
checks = {"rc0": r == 0, "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad,
          "noMountsLeft": not mounts, "peersUnchanged": (O / "peers-before.txt").read_text() == (O / "peers-after.txt").read_text()}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
rec = {"format": "recovery-multipart-test-receipt/r2", "suite": "e2e", "pass": all(checks.values()), "checks": checks, "expectedTests": int(n),
       "ran": ran, "rc": r, "badMarkers": bad, "stageSums": sha(M / "SHA256SUMS"), "multipartSha256": sha(M / "multipart.py"),
       "orchestrateSha256": sha(M / "orchestrate.py"), "testsSha256": sha(M / "tests" / "test_e2e.py")}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
(cd "$M" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## r9 changed during the run"; rc=1; }
tail -3 "$O/stderr.txt"; cat "$O/receipt.json"
[ $rc = 0 ] && echo "## PASS ($N)" || echo "## FAIL"
echo "## outputs $O"; echo "## rmp-r2-e2e rc=$rc"; exit $rc
