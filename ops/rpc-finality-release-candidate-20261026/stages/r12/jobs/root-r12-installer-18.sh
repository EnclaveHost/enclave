#!/bin/bash
# base-finality-proof-stage/r12: root's FIRST, narrow job - the full installer suite (18) on the frozen r12 bytes (PREPARED; NOT run by Claude).
# Then run jobs/root-finality-r12-tests.sh (the composition qualification). Queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r12
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1024 --log $ST/logs/root-r12-installer-18.guard -- unshare -rn bash $ST/jobs/root-r12-installer-18.sh > $ST/logs/root-r12-installer-18.out 2>&1; echo $? > $ST/logs/root-r12-installer-18.rc
set -uo pipefail
export PATH=/usr/bin:/bin
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r12; OUT=$ST/logs/root-r12-installer-18-$(date -u +%Y%m%dT%H%M%SZ)-$$
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || { echo "## SETUP: output dir"; echo "## r12-installer rc=9"; exit 9; }
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## SETUP: r12 differs from SHA256SUMS"; echo "## r12-installer rc=9"; exit 9; }
SC=$OUT/stage; mkdir -p $SC && (cd $ST && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd $SC && tar -xf -) || { echo "## r12-installer rc=9"; exit 9; }
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 600 /usr/bin/python3 -I -B tests/test_ops_installer.py -v < /dev/null) > $OUT/ops-installer.txt 2>&1; r=$?
f=$OUT/ops-installer.txt; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1); rc=0
if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = 18 ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS ops-installer Ran 18 (expected 18)"
else echo "## FAIL: ops-installer: rc $r, Ran ${ran:-?} (expected 18), last ${last:-none} (see $f)"; rc=1; fi
echo "## outputs: $OUT"; echo "## r12-installer SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## r12-installer rc=$rc"; exit $rc
