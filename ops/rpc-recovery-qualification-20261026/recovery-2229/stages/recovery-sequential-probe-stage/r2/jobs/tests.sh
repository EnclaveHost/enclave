#!/bin/bash
# recovery-sequential-probe-stage/r2 fixture tests (prepared by Claude 1738/1741; NOT run by Claude). Never touches the original.
#   bash jobs/q-exit-status.sh seqprobe-r2-tests 512 bash recovery-sequential-probe-stage/r2/jobs/tests.sh
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-sequential-probe-stage/r2/jobs/common.sh
pins_ok
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $S/runs && mkdir -m 0700 $O $O/work || die "run dir"
env -i PATH=$PATH LC_ALL=C RECOVERY_SEQPROBE_WORK=$O/work timeout -k 10 400 python3 -I -B -u -W always::ResourceWarning $S/tests/test_seqprobe.py \
  > $O/stdout.txt 2> $O/stderr.txt; rc=$?
last=$(grep . $O/stderr.txt | tail -1)
if [ $rc = 0 ] && grep -q "^Ran 7 tests" $O/stderr.txt && [ "$last" = OK ] && [ ! -s $O/stdout.txt ] && ! grep -qE "ResourceWarning|skipped|FAIL|ERROR|Traceback" $O/stderr.txt; then
  grc=0; echo "## PASS (7)"; else grc=1; echo "## FAIL"; tail -30 $O/stderr.txt; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; grc=1; }
echo "## outputs $O"; echo "## seqprobe-r2-tests rc=$grc"; exit $grc
