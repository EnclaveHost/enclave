#!/bin/bash
# recovery-sequential-probe-stage/r1 REAL bounded read-only sequential timing of the ORIGINAL (prepared by Claude 1738; NOT run by Claude).
# Only after the fixture tests passed (logs/seqprobe-r1-tests.rc = 0). 4 x 64 MiB, concurrency 1, 45 s + 5 s kill per read, <= 240 s
# total, timings only. REFUSES (nothing read) if anything names the original. USB writes / download / VM boot stay paused.
#   bash jobs/q-exit-status.sh seqprobe-r1-real 512 bash recovery-sequential-probe-stage/r1/jobs/root-real.sh
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-sequential-probe-stage/r1/jobs/common.sh
pins_ok
[ "$(cat $P/logs/seqprobe-r1-tests.rc 2>/dev/null)" = 0 ] && grep -q "^## seqprobe-r1-tests rc=0$" $P/logs/seqprobe-r1-tests.out || die "the fixture tests have not passed"
O=$S/runs/real-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $S/runs || die "runs"
env -i PATH=$PATH LC_ALL=C timeout -k 10 300 python3 -I -B $S/seqprobe.py real --out-dir $O < /dev/null; rc=$?
echo "## outputs $O"; echo "## seqprobe-r1-real rc=$rc (0 timings written; 3 refused, nothing read; 4 identity/cleanup problem: STOP)"; exit $rc
