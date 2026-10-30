#!/bin/bash
# composite-mdbx-validation-stage/r1 PRODUCTION diagnostic (PREPARED by Claude 1782; NOT run). Root ONLY after ALL of: (1) a passing
# cmv-r1-tests receipt for these SUMS; (2) recovery-multipart r3 status: all 265 parts committed + verified in CONFIRMED sessions;
# (3) a PRODUCTION view made by multipart-validation-view-stage/r6 jobs/root-view-import.sh (recheck OK); (4) a host memory window
# (mdbx_chk's ~556 MB pagemap + reclaimable page cache; the 16 GiB floor is the queue guard's) and a schedule for a ~1.13 TB read.
#   bash jobs/q-exit-status.sh cmv-r1-prod 2048 bash composite-mdbx-validation-stage/r1/jobs/root-composite-validate.sh VIEW_DIR [VALIDATOR_TIMEOUT_SEC]
# Run as the owner of the parts/view (r3 open_dir). Default kind production; no --fixture-exec. Writes ONLY a new run dir under r1/runs.
# Stop: bash composite-mdbx-validation-stage/r1/jobs/stop-session.sh RUN_DIR   (our session PID only).
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composite-mdbx-validation-stage/r1/jobs/common.sh
VIEW=${1:?VIEW_DIR}; T=${2:-604800}
guards
R=$(ls -d "$S"/runs/tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$R" ] && python3 -I -B -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("pass") is True and r.get("stageSums")==sys.argv[2] else 1)' \
  "$R/receipt.json" "$(sha256sum < $S/SHA256SUMS | cut -c1-64)" || die "no passing cmv-r1-tests receipt for these SUMS"
O=$S/runs/prod-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -m 0700 "$O" || die "run dir"
python3 -I -B $S/composite_session.py --view-dir "$VIEW" --run-dir "$O" --expect-kind production --validator-timeout "$T"; rc=$?
grep -F "$O" /proc/self/mountinfo && { echo "## MOUNT LEFT under $O: stop and inspect"; rc=4; }
echo "## run $O"; echo "## cmv-r1-prod rc=$rc (0 CLEAN, 2 PROBLEMS, 3 REFUSED, 4 CLEANUP-INCOMPLETE, 5 CANCELLED, 7 INCONCLUSIVE, 8 VOID)"; exit $rc
