#!/bin/bash
# composite-mdbx-validation-stage/r9 PRODUCTION structural MDBX check, memory-aware (PREPARED by Claude 1825/1829; NOT run). MANUAL ONLY:
# never launched by the copy driver or any other job; the r7 2560 MiB path is NOT used. Root runs it ONLY after: a passing cmv-r9-tests
# receipt for these SUMS (checked here); recovery-multipart r3 status with ALL 265 parts committed + independently verified in CONFIRMED
# sessions and the r6 PRODUCTION view (both re-checked by the gate); a coordinated window in the 4096 MiB MAIN lane (exclusive with
# 1024 MiB preservation jobs) with the 16 GiB host floor:
#   bash jobs/q-exit-status.sh cmv-r9-prod 4096 bash composite-mdbx-validation-stage/r9/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# File bounds (review 1827 A2): the gate + runtime run under `ulimit -f 32768` (J/stdout, J/stderr, gate.json / gate-refused.json,
# session/receipt.json, session.pid <= 32 MiB each); r6 children 16 MiB each (qemu-nbd.log, nbdfuse.log, validator.out, mdbx-report.json);
# this job's own files run under `ulimit -f 1024` (peers-before/after, mounts-left, processes-left, receipt.json, FINAL-EVIDENCE-FAILED
# <= 1 MiB each, inside the 16 MiB small-files allowance of the gate's 208 MiB output budget). NOT bounded by r9: the shared queue's own
# logs/cmv-r9-prod.{out,guard,rc} (it captures this job's stdout: here only the <= 1 MiB job receipt and a few status lines).
# Time: the runtime's validator limit is MAX_HOURS + 600 s; `timeout -s TERM -k 600 (MAX_HOURS*3600 + 1800)`: TERM = the runtime's ORDERED
# cancel; KILL (600 s later) hits ONLY the owned runtime (ordered cleanup skipped; servers end by PDEATHSIG; a dead FUSE mount / D-state
# process may remain and is recorded). Stop earlier (that runtime only, identity + pidfd checked):
#   bash composite-mdbx-validation-stage/r9/jobs/stop-session.sh <r9 runs/prod-ID>/session
# Exit (jobs/final-status.sh): a nonzero runtime rc is preserved (2 PROBLEMS, 3 REFUSED, 4 CLEANUP-INCOMPLETE, 5 CANCELLED/soft stop,
# 7 INCONCLUSIVE, 8 VOID, 124 TERM, 137 KILL); runtime 0 stays 0 ONLY with complete, well-formed final evidence, else 10 (FINAL EVIDENCE
# FAILED, J/FINAL-EVIDENCE-FAILED). CLEAN is STRUCTURAL ONLY; no production acceptance.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R9=$P/composite-mdbx-validation-stage/r9
VIEW=${1:?VIEW_DIR}; HOURS=${2:?MAX_HOURS}
[[ "$HOURS" =~ ^[0-9]+$ ]] && [ "$HOURS" -ge 1 ] && [ "$HOURS" -le 168 ] || { echo "## REFUSED: MAX_HOURS must be 1..168"; exit 9; }
(cd $R9 && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: r9 != SHA256SUMS"; exit 9; }
source $P/composite-mdbx-validation-stage/r6/jobs/common.sh        # the QUALIFIED r6 guards: pinned stages, live sessions, stage mounts
guards
python3 -I -B $R9/memory_gate.py guard || die "a memory_gate.py gate/runtime process is live (or the guard failed)"   # root 1828 #3
if grep -qF '/composite-memory-fixture-stage/' /proc/self/mountinfo; then die "a memory-fixture stage mount exists"; fi
T=$(ls -d "$R9"/runs/tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$T" ] && python3 -I -B -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("pass") is True and r.get("stageSums")==sys.argv[2] else 1)' \
  "$T/receipt.json" "$(sha256sum < $R9/SHA256SUMS | cut -c1-64)" || die "no passing cmv-r9-tests receipt for these SUMS"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
O=$R9/runs/prod-$ID; J=$R9/runs/job-$ID                            # the gate's run dir must start EMPTY: job files live in J
mkdir -p "$R9/runs" && chmod 0700 "$R9/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$J" || die "run dir"
( ulimit -f 1024; peer_snapshot > $J/peers-before.txt )
LIMIT=$((HOURS * 3600 + 1800))
( ulimit -f 32768; exec timeout -s TERM -k 600 $LIMIT python3 -I -B $R9/memory_gate.py gate --view-dir "$VIEW" --run-dir "$O" \
    --max-hours "$HOURS" --tree-root-pid $$ ) > $J/stdout.txt 2> $J/stderr.txt; rc=$?
( ulimit -f 1024
  peer_snapshot > $J/peers-after.txt
  grep -F "$O" /proc/self/mountinfo > $J/mounts-left.txt
  pgrep -u "$(id -u)" -a -f "$O" | grep -v -F "pgrep" > $J/processes-left.txt   # diagnostic only: nothing is signalled
  python3 -I -B - "$O" "$J" "$rc" <<'PY' > $J/receipt.json
import json, pathlib, sys
O, J, rc = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
p = O / "session" / "receipt.json"
try:
    r = json.loads(p.read_text()) if p.exists() else {}
    if not isinstance(r, dict):
        r = {}
except ValueError:
    r = {"outcome": "MALFORMED runtime receipt"}
killed, termed = rc in (137, 128 + 9), rc == 124
mem = r.get("memory") if isinstance(r.get("memory"), dict) else {}
checks = {"rc0": rc == 0, "clean": r.get("outcome") == "CLEAN", "cleanupComplete": r.get("cleanupComplete") is True,
          "peersUnchanged": (J / "peers-before.txt").read_text() == (J / "peers-after.txt").read_text(),
          "noMountLeft": (J / "mounts-left.txt").read_text() == "", "noProcessLeft": (J / "processes-left.txt").read_text() == ""}
rec = {"format": "composite-production-memory-job-receipt/r9", "structurallyCleanRun": all(checks.values()), "checks": checks, "rc": rc,
       "runtimeKilled": killed, "wrapperTerm": termed, "outcome": ("CLEANUP-INCOMPLETE (runtime killed by the wrapper)" if killed else r.get("outcome")),
       "reasons": (r.get("reasons") or [])[:8], "memoryPeaks": mem.get("peaks"), "softStop": mem.get("softStop"), "memoryDirty": mem.get("memoryDirty"),
       "mountsLeft": (J / "mounts-left.txt").read_text()[:4000], "processesLeft": (J / "processes-left.txt").read_text()[:4000],
       "meaning": "CLEAN = mdbx_chk structural check only; not chain/state/trie/canonical-root/RPC validation, not a production acceptance"}
print(json.dumps(rec, indent=1, sort_keys=True, default=str)); sys.exit(0 if rec["structurallyCleanRun"] else 1)
PY
)
jrc=$?
( ulimit -f 1024; exec bash $R9/jobs/final-status.sh "$rc" "$jrc" "$J/receipt.json" "$J" ); final=$?
cat $J/receipt.json 2>/dev/null; [ -s $J/mounts-left.txt ] && echo "## MOUNT LEFT under $O: stop and inspect (never re-run over it)"
[ -e $J/FINAL-EVIDENCE-FAILED ] && echo "## $(cat $J/FINAL-EVIDENCE-FAILED)"
echo "## gate/runtime $O ; job $J"; echo "## cmv-r9-prod runtime rc=$rc job-receipt rc=$jrc final rc=$final"
exit $final
