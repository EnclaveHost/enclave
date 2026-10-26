#!/bin/bash
# rpc-qualification-vm-stage/r1: ROOT offline tests (prepared by Claude; NOT run). Reads the pinned production launcher/manifest/units
# only (stat of os.qcow2, no open); never runs QEMU/systemd-run/ssh/nbdfuse/qemu-img. NOT under `unshare -U` (the launcher's manifest
# uid check needs the real uid). HOME is not set.
#   bash jobs/q-exit-status.sh qualvm-r1 256 bash rpc-qualification-vm-stage/r1/jobs/root-qualvm-r1-tests.sh
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/rpc-qualification-vm-stage/r1
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## qualvm-r1 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
TMPDIR=$OUT/tmp timeout -k 10 300 python3 -I -m unittest discover -s $S/test -t $S/test -p test_qualvm.py -v > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 4 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
rm -rf $OUT/tmp; echo "## outputs: $OUT"; echo "## qualvm-r1 rc=$rc"; exit $rc
