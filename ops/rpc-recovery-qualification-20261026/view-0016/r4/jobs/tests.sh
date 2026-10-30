#!/bin/bash
# multipart-validation-view-stage/r4 FIXTURE tests (PREPARED by Claude 1759; NOT run by Claude). Root, via the shared queue:
#   bash jobs/q-exit-status.sh mvv-r4-tests 256 unshare -Urn bash multipart-validation-view-stage/r4/jobs/tests.sh
# Two suites, each in its own process and receipt check: view_descriptor (r3's 5, unchanged) + production_import (5; real r3 records
# made by the pinned r3 multipart.py CLI in fixture mode). Unprivileged owner only; tiny files under $MVV_TEST_TMP (TMPDIR/HOME
# untouched); pinned qemu-io / qemu-img / qemu-nbd 11.1.2. No production manifest/part, original, MDBX file, device, VM, USB or network.
# PASS only if BOTH: exactly "Ran 5 tests", last stderr line "OK", stdout EMPTY, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0.
# The run dir and receipt are RETAINED (only fixture tmp dirs are removed). Bounds per suite: 600 s wall, 300 s CPU.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin
read -r _in outer _n < /proc/self/uid_map
[ "$outer" != 0 ] || { echo "REFUSED: run as the unprivileged owner under unshare -Urn, never as real root"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[ "$S" = /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/multipart-validation-view-stage/r4 ] || { echo "unexpected stage path"; exit 9; }
source "$S/jobs/pins.sh"; pins_ok || exit 9
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && mkdir -m 0700 "$O" || { echo "run dir exists or cannot be created"; exit 9; }
for t in view_descriptor production_import; do
  mkdir -m 0700 "$O/tmp-$t" || exit 9
  (cd "$O" && ulimit -t 300 && env -i PATH=$PATH MVV_TEST_TMP="$O/tmp-$t" timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning \
    "$S/tests/test_$t.py") > "$O/$t.stdout.txt" 2> "$O/$t.stderr.txt"; echo $? > "$O/$t.rc"
done
python3 -I -B - "$O" "$S" <<'PY' > "$O/receipt.json"; rc=$?
import hashlib, json, re, sys, pathlib
O, S = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
suites = {}
for t, n in (("view_descriptor", "5"), ("production_import", "5")):
    out, err = (O / f"{t}.stdout.txt").read_text(errors="replace"), (O / f"{t}.stderr.txt").read_text(errors="replace")
    r = int((O / f"{t}.rc").read_text())
    lines = [l for l in err.splitlines() if l.strip()]
    ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
    bad = [w for w in ("ResourceWarning", "skipped", "FAIL", "ERROR", "Traceback") if w in out or w in err]
    checks = {"rc0": r == 0, "ranExactly": ran == [n], "lastLineOK": bool(lines) and lines[-1] == "OK", "stdoutEmpty": out == "", "noBadMarkers": not bad}
    suites[t] = {"pass": all(checks.values()), "checks": checks, "expectedTests": int(n), "ran": ran, "rc": r, "badMarkers": bad,
                 "testsSha256": sha(S / "tests" / f"test_{t}.py")}
rec = {"format": "multipart-validation-view-test-receipt/r4", "pass": all(s["pass"] for s in suites.values()), "suites": suites,
       "stageSums": sha(S / "SHA256SUMS"), "viewDescriptorSha256": sha(S / "view_descriptor.py"),
       "productionImportSha256": sha(S / "production_import.py"),
       "r3MultipartSha256": sha(pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-multipart-stage/r3/multipart.py")),
       "scope": "tiny fixtures only; real r3 fixture records; no production manifest or part, no MDBX file, no integrity claim"}
print(json.dumps(rec, indent=1, sort_keys=True)); sys.exit(0 if rec["pass"] else 1)
PY
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
for t in view_descriptor production_import; do tail -2 "$O/$t.stderr.txt"; rm -rf "$O/tmp-$t"; done; cat "$O/receipt.json"
[ $rc = 0 ] && echo "## PASS (5+5)" || echo "## FAIL"
echo "## receipt $O/receipt.json"; echo "## mvv-r4-tests rc=$rc"; exit $rc
