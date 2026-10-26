#!/bin/bash
# base-retention-stage/selection-r4: ROOT offline tests (prepared by Claude; NOT run by Claude). Host only; no guest, unit or network.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh base-retention-selection-r4 256 unshare -Urn bash base-retention-stage/selection-r4/jobs/root-selection-r4-tests.sh
# Sparse files only (apparent TBs, ~0 real bytes) under $OUT/tmp, removed after; the real manifest copy is read only; no __pycache__
# is written (the tests set sys.dont_write_bytecode). HOME is not assigned. PASS = "Ran 13 tests" and "OK", stage sums unchanged.
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/base-retention-stage/selection-r4
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## selection-r4 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
for d in selection-r4 selection-r3 activation-r2; do (cd $P/base-retention-stage/$d && sha256sum -c --quiet SHA256SUMS) || die "$d != SHA256SUMS"; done
(cd $S && TMPDIR=$OUT/tmp timeout -k 10 600 python3 -I -m unittest -v test_selection_r4) > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 13 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
for d in selection-r4 selection-r3 activation-r2; do (cd $P/base-retention-stage/$d && sha256sum -c --quiet SHA256SUMS) || { echo "## $d changed during the run"; rc=1; }; done
rm -rf $OUT/tmp
echo "## outputs: $OUT"; echo "## selection-r4 rc=$rc"; exit $rc
