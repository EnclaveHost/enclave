#!/bin/bash
# rpc-qualification-vm-stage/r5: ROOT offline tests (prepared by Claude; NOT run). SOURCE FIXTURES: systemctl/systemd-run/ssh/QMP/debugfs/
# nbdfuse are stubbed; the pinned production launcher/manifest/units are only read. Never maps a disk, starts QEMU or any unit. NOT under
# `unshare -U` (the launcher's manifest uid check needs the real uid). HOME is not set.
#   bash jobs/q-exit-status.sh qualvm-r5 512 bash rpc-qualification-vm-stage/r5/jobs/root-qualvm-r5-tests.sh
# (`qualvm.py inventory` and the CONTROLLER are separate root runs, see logs/claude-qualvm-r5.md.)
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/rpc-qualification-vm-stage/r5
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## qualvm-r5 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
for r in r1 r2 r3 r4; do (cd $P/rpc-qualification-vm-stage/$r && sha256sum -c --quiet SHA256SUMS) || die "$r changed (must stay frozen)"; done
TMPDIR=$OUT/tmp timeout -k 10 300 python3 -I -B -m unittest discover -s $S/test -t $S/test -p test_qualvm.py -v > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 28 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
rm -rf $OUT/tmp; echo "## outputs: $OUT"; echo "## qualvm-r5 rc=$rc"; exit $rc
