#!/bin/bash
# composite-mdbx-validation-stage/r7 PRODUCTION entry (PREPARED by Claude 1802; NOT run). MANUAL ONLY - never launched by the copy driver.
# Root runs it ONLY after ALL of: (1) a passing cmv-r7-gate-tests receipt for these SUMS (checked here); (2) recovery-multipart r3 status:
# ALL 265 parts committed + independently verified in CONFIRMED sessions; (3) the r6 PRODUCTION view of manifest f94807f7... made by
# multipart-validation-view-stage/r6 jobs/root-view-import.sh; (4) a coordinated window: the 2560 MiB main lane (exclusive with the
# 1024 MiB preservation jobs by the queue's single main flock), the 16 GiB host floor, and the duration (--max-hours, <= 168).
#   bash jobs/q-exit-status.sh cmv-r7-prod 2560 bash composite-mdbx-validation-stage/r7/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# The gate (production_gate.py) re-checks the r6 stage, the EXACT r6 4+12 qualification receipt, the 2560 MiB cgroup + floor, and the
# real view (r6 importer: load_view production + recheck; manifest f94807f7..., 1,138,166,333,440 bytes, 265 parts), then execs the
# UNCHANGED r6 runtime. Stop: bash composite-mdbx-validation-stage/r6/jobs/stop-session.sh RUN_DIR/session (that session PID only).
# Outcomes are the r6 runtime's: CLEAN is STRUCTURAL ONLY; canonical / state / trie validation is separate. No production acceptance.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R7=$P/composite-mdbx-validation-stage/r7
VIEW=${1:?VIEW_DIR}; HOURS=${2:?MAX_HOURS}
(cd $R7 && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: r7 != SHA256SUMS"; exit 9; }
source $P/composite-mdbx-validation-stage/r6/jobs/common.sh        # the QUALIFIED r6 guards: pinned stages, live-session + stage-mount refusal
guards
T=$(ls -d "$R7"/runs/gate-tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$T" ] && python3 -I -B -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("pass") is True and r.get("stageSums")==sys.argv[2] else 1)' \
  "$T/receipt.json" "$(sha256sum < $R7/SHA256SUMS | cut -c1-64)" || die "no passing cmv-r7-gate-tests receipt for these SUMS"
O=$R7/runs/prod-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -m 0700 "$O" || die "run dir"
echo "## run $O"
python3 -I -B $R7/production_gate.py --view-dir "$VIEW" --run-dir "$O" --max-hours "$HOURS"; rc=$?
grep -F "$O" /proc/self/mountinfo && { echo "## MOUNT LEFT under $O: stop and inspect"; rc=4; }
echo "## cmv-r7-prod rc=$rc (3 gate/session REFUSED; r6 runtime: 0 CLEAN(structural only), 2 PROBLEMS, 4 CLEANUP-INCOMPLETE, 5 CANCELLED, 7 INCONCLUSIVE, 8 VOID)"; exit $rc
