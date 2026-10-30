#!/bin/bash
# base-forward-sync-stage/r2 targeted regression (PREPARED; NOT run by Claude). Pure-module, offline; exact count 6, no skip.
# Root, from work/rpc-production-final-20261025:
#   python3 -u ../claude-test-queue.py --mib 512 --log base-forward-sync-stage/r2/logs/root-forward-sync-r2-unit.guard -- unshare -rn bash base-forward-sync-stage/r2/jobs/root-forward-sync-r2-unit.sh
set -uo pipefail
export PATH=/usr/bin:/bin; ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/base-forward-sync-stage/r2
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## SETUP: r2 differs from SHA256SUMS"; exit 9; }
[ "$(sha256sum < $P/logs/base-live-help-0603/help.txt | cut -c1-64)" = "$(cat $S/HELP-PIN.sha256)" ] || { echo "## SETUP: pinned help changed"; exit 9; }
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $OUT/tmp
(cd $S && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FORWARD_SYNC_SRC=$S/src R2_PRODUCER=$S/r6-followup/producer/base_launch.py \
   BASE_HELP=$P/logs/base-live-help-0603/help.txt timeout 600 /usr/bin/python3 -I -B tests/test_forward_sync_r2.py < /dev/null) > $OUT/r2-unit.txt 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+' $OUT/r2-unit.txt | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $OUT/r2-unit.txt | tail -1)
if [ $r = 0 ] && [ "$ran" = 6 ] && [ "$last" = OK ] && ! grep -q skipped $OUT/r2-unit.txt; then echo "PASS r2-unit Ran 6"; rc=0; else echo "FAIL r2-unit rc $r ran ${ran:-?} last ${last:-none}"; rc=1; fi
echo "## forward-sync r2 rc=$rc"; exit $rc
