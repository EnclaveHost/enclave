#!/bin/bash
# cold-scan v3: ROOT runs the supervisor's UNPRIVILEGED tests (v2's job with v3 paths, Claude 1615; NOT run by Claude). Fixtures only (temp files,
# /bin/sh + sleep children); no sudo, no network, no scan. Expects exactly "Ran 8 tests" + OK.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh root-cold-scan-v3-tests 512 unshare -Urn bash /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/cold-scan-v3/run-supervisor-tests.sh
set -uo pipefail
export PATH=/usr/bin:/bin LC_ALL=C
V=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/cold-scan-v3
(cd $V && sha256sum -c --quiet SHA256SUMS) || { echo "## cold-scan-v3 files != SHA256SUMS"; echo "## cold-scan-v3-tests rc=9"; exit 9; }
echo "## verified SHA256SUMS $(sha256sum < $V/SHA256SUMS | cut -c1-64)"
T=$(mktemp -d); trap 'rm -rf -- "$T"' EXIT
(cd $T && env -i PATH=$PATH LC_ALL=C TMPDIR=$T PYTHONDONTWRITEBYTECODE=1 timeout -k 5 300 python3 -I -B $V/test_root_scan_supervisor.py -v < /dev/null) > $T/out.txt 2>&1; r=$?
cat $T/out.txt
rc=1; grep -q "^Ran 8 tests" $T/out.txt && tail -1 $T/out.txt | grep -qx OK && ! grep -q skipped $T/out.txt && [ $r = 0 ] && rc=0
(cd $V && sha256sum -c --quiet SHA256SUMS) || { echo "## cold-scan-v3 files changed during the run"; rc=1; }
[ -z "$(find $V -name __pycache__ -o -name '*.pyc')" ] || { echo "## bytecode written into cold-scan-v3"; rc=1; }
echo "## cold-scan-v3-tests rc=$rc"; exit $rc
