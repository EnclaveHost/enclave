#!/bin/bash
# composite-mdbx-validation-stage/r10 PRODUCTION structural MDBX check, memory-aware (PREPARED by Claude 1825/1829/1833; NOT run). MANUAL ONLY:
# never launched by the copy driver or any other job; the r7 2560 MiB path is NOT used. Root runs it ONLY after: a passing cmv-r10-tests
# receipt for these SUMS (checked here); recovery-multipart r3 status with ALL 265 parts committed + independently verified in CONFIRMED
# sessions and the r6 PRODUCTION view (both re-checked by the gate); a coordinated window in the 4096 MiB MAIN lane (exclusive with
# 1024 MiB preservation jobs) with the 16 GiB host floor:
#   bash jobs/q-exit-status.sh cmv-r10-prod 4096 bash composite-mdbx-validation-stage/r10/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# File bounds (review 1827 A2): the gate + runtime run under `ulimit -f 32768` (J/stdout, J/stderr, gate.json / gate-refused.json,
# session/receipt.json, session.pid <= 32 MiB each); r6 children 16 MiB each (qemu-nbd.log, nbdfuse.log, validator.out, mdbx-report.json);
# this job's own files are written under `ulimit -f 1024` (peers-before/after, status-before/after, mounts-left, processes-left, receipt.json,
# FINAL-EVIDENCE-FAILED: 8 files <= 1 MiB each, inside the 16 MiB small-files allowance of the gate's 208 MiB output budget).
# r10 (review 1831 B1): every evidence command's status is captured (jobs/collect-evidence.sh); a failed BEFORE collection refuses before
# the gate/runtime starts; a failed AFTER collection, or missing / malformed / truncated status or evidence, makes runtime 0 -> 10. NOT bounded by r9: the shared queue's own
# logs/cmv-r10-prod.{out,guard,rc} (it captures this job's stdout: here only the <= 1 MiB job receipt and a few status lines).
# Time: the runtime's validator limit is MAX_HOURS + 600 s; `timeout -s TERM -k 600 (MAX_HOURS*3600 + 1800)`: TERM = the runtime's ORDERED
# cancel; KILL (600 s later) hits ONLY the owned runtime (ordered cleanup skipped; servers end by PDEATHSIG; a dead FUSE mount / D-state
# process may remain and is recorded). Stop earlier (that runtime only, identity + pidfd checked):
#   bash composite-mdbx-validation-stage/r10/jobs/stop-session.sh <r10 runs/prod-ID>/session
# Exit (jobs/final-status.sh): a nonzero runtime rc is preserved (2 PROBLEMS, 3 REFUSED, 4 CLEANUP-INCOMPLETE, 5 CANCELLED/soft stop,
# 7 INCONCLUSIVE, 8 VOID, 124 TERM, 137 KILL); runtime 0 stays 0 ONLY with complete, well-formed final evidence, else 10 (FINAL EVIDENCE
# FAILED, J/FINAL-EVIDENCE-FAILED). CLEAN is STRUCTURAL ONLY; no production acceptance.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R10=$P/composite-mdbx-validation-stage/r10
VIEW=${1:?VIEW_DIR}; HOURS=${2:?MAX_HOURS}
[[ "$HOURS" =~ ^[0-9]+$ ]] && [ "$HOURS" -ge 1 ] && [ "$HOURS" -le 168 ] || { echo "## REFUSED: MAX_HOURS must be 1..168"; exit 9; }
(cd $R10 && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: r10 != SHA256SUMS"; exit 9; }
source $P/composite-mdbx-validation-stage/r6/jobs/common.sh        # the QUALIFIED r6 guards: pinned stages, live sessions, stage mounts
guards
python3 -I -B $R10/memory_gate.py guard || die "a memory_gate.py gate/runtime process is live (or the guard failed)"   # root 1828 #3
if grep -qF '/composite-memory-fixture-stage/' /proc/self/mountinfo; then die "a memory-fixture stage mount exists"; fi
T=$(ls -d "$R10"/runs/tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$T" ] && python3 -I -B -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("pass") is True and r.get("stageSums")==sys.argv[2] else 1)' \
  "$T/receipt.json" "$(sha256sum < $R10/SHA256SUMS | cut -c1-64)" || die "no passing cmv-r10-tests receipt for these SUMS"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
O=$R10/runs/prod-$ID; J=$R10/runs/job-$ID                            # the gate's run dir must start EMPTY: job files live in J
mkdir -p "$R10/runs" && chmod 0700 "$R10/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$J" || die "run dir"
EV=(env -i PATH=/usr/bin:/bin LC_ALL=C EVID_O="$O" EVID_S6="$P/composite-mdbx-validation-stage/r6")   # no inherited PATH / tools
"${EV[@]}" bash $R10/jobs/collect-evidence.sh before "$J" || die "the BEFORE evidence collection failed (status in $J/status-before.txt): nothing started"
LIMIT=$((HOURS * 3600 + 1800))
( ulimit -f 32768; exec timeout -s TERM -k 600 $LIMIT python3 -I -B $R10/memory_gate.py gate --view-dir "$VIEW" --run-dir "$O" \
    --max-hours "$HOURS" --tree-root-pid $$ ) > $J/stdout.txt 2> $J/stderr.txt; rc=$?
"${EV[@]}" bash $R10/jobs/finish.sh "$J" "$rc"; final=$?          # after-collection, receipt, final status (review 1831 B1)
cat $J/receipt.json 2>/dev/null; [ -s $J/mounts-left.txt ] && echo "## MOUNT LEFT under $O: stop and inspect (never re-run over it)"
[ -e $J/FINAL-EVIDENCE-FAILED ] && echo "## $(cat $J/FINAL-EVIDENCE-FAILED)"
echo "## gate/runtime $O ; job $J"; echo "## cmv-r10-prod runtime rc=$rc final rc=$final (see $J/status-before.txt, $J/status-after.txt)"
exit $final
