#!/bin/bash
# journal-recovery-verifier-stage/r1 tests (PREPARED by Claude; NOT run by Claude). Root, offline, through the queue:
#   bash jobs/q-exit-status.sh jrv-r1-tests 256 unshare -Urn bash journal-recovery-verifier-stage/r1/jobs/tests.sh
# PASS only with "Ran 9 tests", a bare OK, no skips, rc 0. Synthetic fixtures + the real 1024-byte journal superblock vector;
# needs /usr/lib/libext2fs.so.2 (ext2fs_crc32c_le). Reads no journal copy and writes only under this stage's runs/.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$O/tmp" || exit 9
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
echo "## verified SHA256SUMS $(sha256sum < "$S/SHA256SUMS" | cut -c1-64)"
[ -z "$(find "$S" -path "$S/runs" -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "bytecode in stage"; exit 9; }
(cd "$O" && env -i PATH=$PATH TEST_TMP="$O/tmp" timeout -k 5 600 python3 -I -B "$S/tests/test_jbd2_verify.py") > "$O/tests.txt" 2>&1; r=$?
tail -3 "$O/tests.txt"
if grep -q '^Ran 9 tests' "$O/tests.txt" && tail -1 "$O/tests.txt" | grep -qx OK && ! grep -q skipped "$O/tests.txt" && [ $r = 0 ]; then rc=0; echo "## PASS (9)"; else rc=1; echo "## FAIL (rc $r)"; fi
rm -rf "$O/tmp"; echo "## jrv-r1-tests rc=$rc"; exit $rc
