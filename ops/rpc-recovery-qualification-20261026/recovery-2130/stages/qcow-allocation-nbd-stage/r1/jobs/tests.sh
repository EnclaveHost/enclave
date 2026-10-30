#!/bin/bash
# qcow-allocation-nbd-stage/r1 FIXTURE tests (prepared by Claude 1705; NOT run by Claude). Unprivileged, NOT under a user namespace (a 0444
# fixture must really be unwritable); unix sockets only, in private temp dirs. Expects "Ran 3 tests" + OK.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh qcow-alloc-r1-tests 512 bash qcow-allocation-nbd-stage/r1/jobs/tests.sh
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/qcow-allocation-nbd-stage/r1/jobs/pins.sh
[ "$(id -u)" != 0 ] || { echo "run unprivileged"; exit 9; }
pins_ok || exit 9
T=$(mktemp -d); trap 'rm -rf -- "$T"' EXIT
(cd $T && env -i PATH=/usr/bin:/bin:/usr/sbin LC_ALL=C TMPDIR=$T ALLOC_QEMU_NBD_SHA256=$QNBD_SHA PYTHONDONTWRITEBYTECODE=1 \
  timeout -k 10 600 python3 -I -B $S/tests/test_alloc_check.py -v < /dev/null) > $T/out.txt 2>&1; r=$?
cat $T/out.txt
rc=1; grep -q "^Ran 3 tests" $T/out.txt && tail -1 $T/out.txt | grep -qx OK && [ $r = 0 ] && rc=0
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
echo "## qcow-alloc-r1-tests rc=$rc"; exit $rc
