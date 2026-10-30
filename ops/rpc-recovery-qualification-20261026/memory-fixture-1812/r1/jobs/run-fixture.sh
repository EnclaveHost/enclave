#!/bin/bash
# composite-memory-fixture-stage/r1 SYNTHETIC memory mechanism fixture (PREPARED by Claude 1810; NOT run by Claude). Root, ONLY through the
# shared queue's 768 MiB MAIN lane (exclusive with 1024 MiB preservation jobs by its single main flock), after a passing cmf-r1-tests:
#   bash jobs/q-exit-status.sh cmf-r1-run 768 bash composite-memory-fixture-stage/r1/jobs/run-fixture.sh
# Owner, NOT under unshare (FUSE + the user manager). Writes ONLY a new run dir under r1/runs on the root target filesystem: an 8 GiB
# SPARSE image (<= 64 MiB allocated, removed after a complete cleanup), logs and receipts. Never /vm, USB, a part, the original or the queue.
# The controller bounds itself (900 s budget, ordered cancel); this job adds `timeout -s TERM 1200` (TERM only: the controller then runs
# its own ordered cleanup; nothing here ever SIGKILLs). PASS only if: controller rc 0 / outcome MEASURED, peers' FUSE mounts and
# qemu-nbd/nbdfuse/fuse2fs processes identical before/after, no mount left under the run dir, the stage unchanged.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-memory-fixture-stage/r1/jobs/common.sh
mguards
T=$(ls -d "$M"/runs/tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$T" ] && python3 -I -B -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("pass") is True and r.get("stageSums")==sys.argv[2] else 1)' \
  "$T/receipt.json" "$(sha256sum < $M/SHA256SUMS | cut -c1-64)" || mdie "no passing cmf-r1-tests receipt for these SUMS"
fixture_guards
ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
O=$M/runs/fixture-$ID; J=$M/runs/job-$ID                          # the controller's run dir must start EMPTY: job files live in J
mkdir -p "$M/runs" && chmod 0700 "$M/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$J" || mdie "run dir"
peer_snapshot > $J/peers-before.txt
timeout -s TERM 1200 python3 -I -B $M/memory_fixture.py --run-dir "$O" --tree-root-pid $$ > $J/stdout.txt 2> $J/stderr.txt; crc=$?
peer_snapshot > $J/peers-after.txt
grep -F "$O" /proc/self/mountinfo > $J/mounts-left.txt
python3 -I -B - "$O" "$J" "$M" "$crc" <<'PY' > $J/receipt.json; rc=$?
import hashlib, json, pathlib, sys
O, J, S, crc = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), int(sys.argv[4])
r = json.loads((O / "receipt.json").read_text()) if (O / "receipt.json").exists() else {}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
checks = {"controllerRc0": crc == 0, "measured": r.get("outcome") == "MEASURED", "cleanupComplete": r.get("cleanupComplete") is True,
          "peersUnchanged": (J / "peers-before.txt").read_text() == (J / "peers-after.txt").read_text(),
          "noMountLeft": (J / "mounts-left.txt").read_text() == ""}
rec = {"format": "composite-memory-fixture-job-receipt/r1", "pass": all(checks.values()), "checks": checks, "controllerRc": crc,
       "outcome": r.get("outcome"), "reasons": r.get("reasons"), "peaks": r.get("peaks"), "walker": r.get("walker"),
       "controllerReceiptSha256": sha(O / "receipt.json") if (O / "receipt.json").exists() else None, "stageSums": sha(S / "SHA256SUMS"),
       "scope": "synthetic mechanism measurement only; not MDBX, not production qualification"}
print(json.dumps(rec, indent=1, sort_keys=True, default=str)); sys.exit(0 if rec["pass"] else 1)
PY
(cd $M && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
cat $J/receipt.json; [ -s $J/mounts-left.txt ] && echo "## MOUNT LEFT under $O: stop and inspect (never re-run over it)"
[ $rc = 0 ] && echo "## PASS (fixture MEASURED)" || echo "## FAIL"
echo "## controller receipt $O/receipt.json"; echo "## job receipt $J/receipt.json"; echo "## cmf-r1-run rc=$rc"; exit $rc
