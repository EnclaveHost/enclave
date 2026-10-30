#!/bin/bash
# rpc-qualification-vm-stage/r3: ROOT offline tests (prepared by Claude; NOT run). SOURCE FIXTURES: systemctl/systemd-run/ssh/QMP stubbed;
# the pinned production launcher/manifest/units are only read. Never starts QEMU or any unit. NOT under `unshare -U` (the launcher's
# manifest uid check needs the real uid). HOME is not set.
#   bash jobs/q-exit-status.sh qualvm-r3 256 bash rpc-qualification-vm-stage/r3/jobs/root-qualvm-r3-tests.sh
# (The CONTROLLER itself is a different, later, root-coordinated run: only in the 512 MiB main lane, see the README.)
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/rpc-qualification-vm-stage/r3
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## qualvm-r3 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
for r in r1 r2; do (cd $P/rpc-qualification-vm-stage/$r && sha256sum -c --quiet SHA256SUMS) || die "$r changed (must stay frozen)"; done
TMPDIR=$OUT/tmp timeout -k 10 300 python3 -I -m unittest discover -s $S/test -t $S/test -p test_qualvm.py -v > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 13 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
rm -rf $OUT/tmp; echo "## outputs: $OUT"; echo "## qualvm-r3 rc=$rc"; exit $rc
