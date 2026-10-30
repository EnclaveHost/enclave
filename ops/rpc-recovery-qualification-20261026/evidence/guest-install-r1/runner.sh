#!/bin/bash
# guest-state-install-stage/r1: ROOT offline tests (prepared by Claude; NOT run by Claude). Host only: no guest, VM, network or real data.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh gsi-r1 256 unshare -Urn bash guest-state-install-stage/r1/jobs/root-gsi-r1-tests.sh
# Labelled stubs only (extractor with its fault mode baked into its own file; SHA-256 "BLAKE3" stub with a test-only KAT value).
# This is NOT a BLAKE3 or extraction qualification. PASS = "Ran 13 tests" + "OK" + stage sums unchanged. HOME is not set.
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/guest-state-install-stage/r1
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## gsi-r1 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
python3 -I -c 'import sys, tarfile; sys.exit(0 if sys.version_info >= (3, 14) else 1)' || die "needs python >= 3.14 (tarfile zstd)"
(cd $S/test && TMPDIR=$OUT/tmp timeout -k 10 600 python3 -I -m unittest discover -s "$S/test" -p test_guest_state.py -v) > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 13 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
rm -rf $OUT/tmp
echo "## outputs: $OUT"; echo "## gsi-r1 rc=$rc"; exit $rc
