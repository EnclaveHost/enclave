#!/bin/bash
# base-retention-stage/selection-r3: ROOT offline tests (prepared by Claude; NOT run by Claude). Host only; no guest, no network.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh base-retention-selection-r3 256 unshare -Urn bash base-retention-stage/selection-r3/jobs/root-selection-r3-tests.sh
# Sparse files only (apparent TBs, ~0 real bytes) under $OUT/tmp; the real manifest copy is read only. PASS = 15 tests OK.
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/base-retention-stage/selection-r3
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## selection-r3 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "selection-r3 != SHA256SUMS"
(cd $S/../activation-r2 && sha256sum -c --quiet SHA256SUMS) || die "activation-r2 changed"
export TMPDIR=$OUT/tmp HOME=$OUT/tmp PYTHONDONTWRITEBYTECODE=1
(cd $S && timeout -k 10 600 python3 -I -m unittest -v test_selection_r3) > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 15 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/tmp
echo "## outputs: $OUT"; echo "## selection-r3 rc=$rc"; exit $rc
