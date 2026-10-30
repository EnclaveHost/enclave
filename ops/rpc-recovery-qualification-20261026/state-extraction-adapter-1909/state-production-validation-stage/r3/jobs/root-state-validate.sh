#!/bin/bash
# state-production-validation-stage/r3 production STATE job (PREPARED by Claude 1890; NOT run by Claude). Root, ONLY after every
# prerequisite in the README (all 265 CONFIRMED; the structural cmv-r10 production CLEAN; the r12 build + capture r3 receipts; the
# header extraction; this stage's tests PASS; a reviewed revision that pins PRODUCTION_INPUTS):
#   bash jobs/q-exit-status.sh state-prod 4096 bash state-production-validation-stage/r3/jobs/root-state-validate.sh VIEW_DIR MAX_HOURS
# AS PREPARED, state_gate.py gate REFUSES (rc 3): PRODUCTION_INPUTS is None and the header extraction prerequisite is BLOCKED.
# Shape = composite r10 root-composite-validate.sh: the r6 guards + memory_gate/state_gate live guards, the r10 BEFORE/AFTER evidence
# collector (pinned bytes; EVID_S6 = THIS stage so our own session is excluded from the peer snapshot), `ulimit -f 32768`,
# `timeout -s TERM -k 600 (H*3600+1800)`, then `state_gate.py final` (acceptance r3 final_state_status): 35 ONLY with complete bound
# evidence, else 10; runtime 0 -> 10; r2 O1: any OTHER runtime code (3/5/7/8/30/34/124/137) is kept ONLY when every job snapshot and
# the session cleanup are verified, else 4 (acceptance's code stays in final.json). No original write; root writes are the
# job files (<= 32 MiB each) and the session's bounded logs/report.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/state-production-validation-stage/r3
R10=$P/composite-mdbx-validation-stage/r10
CE=9f5322850d63711166b3d7c3d387a4efe5214d95e51d2fe7758dd8a2ec125f2c   # r10 jobs/collect-evidence.sh
VIEW=${1:?VIEW_DIR}; HOURS=${2:?MAX_HOURS}
[[ "$HOURS" =~ ^[0-9]+$ ]] && [ "$HOURS" -ge 1 ] && [ "$HOURS" -le 168 ] || { echo "## REFUSED: MAX_HOURS must be 1..168"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
(cd $R10 && sha256sum -c --quiet SHA256SUMS) && [ "$(sha256sum < $R10/jobs/collect-evidence.sh | cut -c1-64)" = "$CE" ] \
  || { echo "## REFUSED: r10 / collect-evidence.sh not the pinned bytes"; exit 9; }
source $P/composite-mdbx-validation-stage/r6/jobs/common.sh        # the QUALIFIED r6 guards: pinned stages, live sessions, stage mounts
guards
python3 -I -B $S/state_gate.py guard || die "a memory_gate.py / state_gate.py gate/runtime process is live (or the guard failed)"
if grep -qF '/composite-memory-fixture-stage/' /proc/self/mountinfo; then die "a memory-fixture stage mount exists"; fi
T=$(ls -d "$S"/runs/tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$T" ] && python3 -I -B $S/state_gate.py tests-receipt "$T/receipt.json" "$(sha256sum < $S/SHA256SUMS | cut -c1-64)" \
  || die "no exact passing state r3 tests receipt (format r3, 25 tests, the 5 checks) for these SUMS"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
O=$S/runs/prod-$ID; J=$S/runs/job-$ID                              # the gate's run dir must start EMPTY: job files live in J
mkdir -p "$S/runs" && chmod 0700 "$S/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$J" || die "run dir"
EV=(env -i PATH=/usr/bin:/bin LC_ALL=C EVID_O="$O" EVID_S6="$S")   # no inherited PATH / tools; our own runs/ excluded from peers
"${EV[@]}" bash $R10/jobs/collect-evidence.sh before "$J" || die "the BEFORE evidence collection failed: nothing started"
LIMIT=$((HOURS * 3600 + 1800))
( ulimit -f 32768; exec timeout -s TERM -k 600 $LIMIT python3 -I -B $S/state_gate.py gate --view-dir "$VIEW" --run-dir "$O" \
    --max-hours "$HOURS" --tree-root-pid $$ ) > $J/stdout.txt 2> $J/stderr.txt; rc=$?
"${EV[@]}" bash $R10/jobs/collect-evidence.sh after "$J"; arc=$?
( ulimit -f 1024; exec env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B $S/state_gate.py final "$O" "$J" "$rc" "$arc" ) > $J/final.txt 2>&1; final=$?
cat $J/final.txt; [ -s $J/mounts-left.txt ] && echo "## MOUNT LEFT under $O: stop and inspect (never re-run over it)"
echo "## gate/runtime $O ; job $J"; echo "## state-prod runtime rc=$rc final rc=$final (35 = usable PARTIAL v2 self-consistency ONLY; NOT canonical)"
exit $final
