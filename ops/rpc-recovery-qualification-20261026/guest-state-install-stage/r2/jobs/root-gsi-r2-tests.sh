#!/bin/bash
# guest-state-install-stage/r2: ROOT offline tests (prepared by Claude; NOT run by Claude). Host only: no guest, VM, network or real data.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh gsi-r2 256 unshare -Urn bash guest-state-install-stage/r2/jobs/root-gsi-r2-tests.sh
# Labelled stubs only (extractor with its fault mode baked into its own file and tar header modes applied as-is; SHA-256 "BLAKE3"
# stub with a test-only KAT value). NOT a BLAKE3, extraction, confinement or ordering qualification (review Q1-Q4 are root's real
# runs). r2 harness: `python3 -I` puts neither the cwd nor the test dir on sys.path, so unittest DISCOVERS from the absolute test dir.
# PASS = "Ran 16 tests" + "OK" + stage sums unchanged. HOME is not set.
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/guest-state-install-stage/r2
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## gsi-r2 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
(cd $P/guest-state-install-stage/r1 && sha256sum -c --quiet SHA256SUMS) || die "r1 changed (must stay frozen)"
python3 -I -c 'import sys, tarfile; sys.exit(0 if sys.version_info >= (3, 14) else 1)' || die "the TESTS need python >= 3.14 (tarfile zstd); production needs >= 3.12"
TMPDIR=$OUT/tmp timeout -k 10 600 python3 -I -m unittest discover -s $S/test -p test_guest_state.py -t $S/test -v > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 16 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
rm -rf $OUT/tmp
echo "## outputs: $OUT"; echo "## gsi-r2 rc=$rc"; exit $rc
