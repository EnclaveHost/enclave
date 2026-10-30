#!/bin/bash
# pinned-checkpoint-parser focused regression (PREPARED; NOT run by Claude). Pure-module, offline; exact count 8, no skip.
# Root, from work/rpc-production-final-20261025:
#   python3 -u ../claude-test-queue.py --mib 512 --log base-finality-proof-stage/pinned-checkpoint-parser/logs/root-pinned-checkpoints.guard -- unshare -rn bash base-finality-proof-stage/pinned-checkpoint-parser/jobs/root-pinned-checkpoints.sh
set -uo pipefail
export PATH=/usr/bin:/bin; ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/base-finality-proof-stage/pinned-checkpoint-parser
SEL=$P/base-reanchor-recovery-stage/r7/harness                    # selection.py, the harness's only sibling import
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## SETUP: stage differs from SHA256SUMS"; exit 9; }
(cd $P/base-reanchor-recovery-stage/r7 && sha256sum -c --quiet MANIFEST.sha256) || { echo "## SETUP: recovery r7 changed"; exit 9; }
B=$P/base-finality-proof-stage/r6-followup-fixes/harness/a2a4.py; T=$(mktemp -d)
cp $B $T/x && (cd $T && patch -s x < $S/patches/harness-pinned-checkpoints.patch) && cmp -s $T/x $S/harness/a2a4.py || { echo "## SETUP: harness != r6-followup-fixes + patch"; exit 9; }
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $OUT/tmp
(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp HARNESS=$S/harness/a2a4.py HARNESS_DEPS=$SEL timeout 300 /usr/bin/python3 -I -B $S/tests/test_pinned_checkpoints.py < /dev/null) > $OUT/pinned.txt 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+' $OUT/pinned.txt | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $OUT/pinned.txt | tail -1)
if [ $r = 0 ] && [ "$ran" = 8 ] && [ "$last" = OK ] && ! grep -q skipped $OUT/pinned.txt; then echo "PASS pinned-checkpoints Ran 8"; rc=0; else echo "FAIL pinned-checkpoints rc $r ran ${ran:-?} last ${last:-none}"; rc=1; fi
echo "## pinned-checkpoints rc=$rc"; exit $rc
