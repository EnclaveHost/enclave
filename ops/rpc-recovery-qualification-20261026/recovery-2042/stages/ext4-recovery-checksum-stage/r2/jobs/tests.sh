#!/bin/bash
# ext4-recovery-checksum-stage/r2: ROOT runs the OFFLINE qualifier's synthetic-fixture tests (prepared by Claude 1643; NOT run by Claude).
# Fixtures only (temporary files, local libext2fs CRC32c); no device, image, USB, network or journal copy. Expects exactly "Ran 7 tests" + OK.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh ext4-checksum-r2-tests 512 unshare -Urn bash ext4-recovery-checksum-stage/r2/jobs/tests.sh
set -uo pipefail
export PATH=/usr/bin:/bin LC_ALL=C
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/ext4-recovery-checksum-stage/r2
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## ext4-checksum r1 != SHA256SUMS"; echo "## ext4-checksum-r2-tests rc=9"; exit 9; }
echo "## verified SHA256SUMS $(sha256sum < $S/SHA256SUMS | cut -c1-64)"
T=$(mktemp -d); trap 'rm -rf -- "$T"' EXIT
(cd $T && env -i PATH=$PATH LC_ALL=C TMPDIR=$T PYTHONDONTWRITEBYTECODE=1 timeout -k 5 300 python3 -u -I -B $S/tests/test_ext4_candidate_checksums.py -v < /dev/null) > $T/out.txt 2>&1; r=$?
cat $T/out.txt
rc=1; grep -q "^Ran 7 tests" $T/out.txt && tail -1 $T/out.txt | grep -qx OK && ! grep -q skipped $T/out.txt && [ $r = 0 ] && rc=0
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
[ -z "$(find $S -name __pycache__ -o -name '*.pyc')" ] || { echo "## bytecode written into the stage"; rc=1; }
echo "## ext4-checksum-r2-tests rc=$rc"; exit $rc
