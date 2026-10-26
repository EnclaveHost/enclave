#!/bin/bash
# recovery-sequential-probe-stage/r2 REAL bounded read-only sequential timing of the ORIGINAL (prepared by Claude 1738/1741; NOT run by Claude).
# Only after the r2 fixture tests passed (logs/seqprobe-r2-tests.rc = 0). 4 x 64 MiB, concurrency 1, each read through the QUALIFIED
# mdbx_check.py r4 bounded_run (45 s + 2 s held-stdout grace + 5 s kill grace), <= 240 s total, timings only, CONCURRENT-load labelled.
# REFUSES (nothing read) if anything names the original. USB writes / download / VM boot stay paused.
#   bash jobs/q-exit-status.sh seqprobe-r2-real 512 bash recovery-sequential-probe-stage/r2/jobs/root-real.sh
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-sequential-probe-stage/r2/jobs/common.sh
pins_ok
[ "$(cat $P/logs/seqprobe-r2-tests.rc 2>/dev/null)" = 0 ] && grep -q "^## seqprobe-r2-tests rc=0$" $P/logs/seqprobe-r2-tests.out || die "the r2 fixture tests have not passed"
O=$S/runs/real-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $S/runs || die "runs"
env -i PATH=$PATH LC_ALL=C timeout -k 10 300 python3 -I -B $S/seqprobe.py real --out-dir $O < /dev/null; rc=$?
echo "## outputs $O"
echo "## seqprobe-r2-real rc=$rc (0 all 4 samples complete; 5 INCONCLUSIVE: some sample incomplete (counts in result); 3 refused, nothing read; 4 identity/escape/failure after reads began: STOP; 143/129/130 cancelled by signal after the owned read was killed and reaped)"
exit $rc
