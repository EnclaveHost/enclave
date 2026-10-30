#!/bin/bash
# composite-mdbx-validation-stage/r8 PRODUCTION structural MDBX check, memory-aware (PREPARED by Claude 1825; NOT run). MANUAL ONLY: never
# launched by the copy driver or any other job; the r7 2560 MiB path is NOT used. Root runs it ONLY after ALL of: a passing cmv-r8-tests
# receipt for these SUMS (checked here); recovery-multipart r3 status with ALL 265 parts committed + independently verified in CONFIRMED
# sessions and the r6 PRODUCTION view (both re-checked by the gate); explicit production permission; a coordinated window in the
# 4096 MiB MAIN lane (exclusive with 1024 MiB preservation jobs) with the 16 GiB host floor:
#   bash jobs/q-exit-status.sh cmv-r8-prod 4096 bash composite-mdbx-validation-stage/r8/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
# Bounds: every file the run writes is <= 32 MiB (`ulimit -f 32768` here; r6 children 16 MiB); the gate requires free root space for all
# remaining recovery + 40 GiB floor + 8 GiB native + the 208 MiB output budget. Time: the runtime's validator limit is MAX_HOURS + 600 s;
# this job adds `timeout -s TERM -k 600 (MAX_HOURS*3600 + 1800)`: TERM = the runtime's ORDERED cancel; KILL (600 s later) hits ONLY the
# owned runtime: its ordered cleanup is then skipped, servers end by PDEATHSIG only, a dead FUSE mount / D-state process may remain and
# the job records it. Stop earlier: bash composite-mdbx-validation-stage/r6/jobs/stop-session.sh RUN_DIR/session (that session PID only).
# Outcomes are the r6 runtime's (+ r8: a memory soft stop is CANCELLED; an OOM event downgrades CLEAN/PROBLEMS to INCONCLUSIVE):
# 0 CLEAN (STRUCTURAL ONLY), 2 PROBLEMS, 3 REFUSED, 4 CLEANUP-INCOMPLETE, 5 CANCELLED, 7 INCONCLUSIVE, 8 VOID. No production acceptance.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R8=$P/composite-mdbx-validation-stage/r8
VIEW=${1:?VIEW_DIR}; HOURS=${2:?MAX_HOURS}
[[ "$HOURS" =~ ^[0-9]+$ ]] && [ "$HOURS" -ge 1 ] && [ "$HOURS" -le 168 ] || { echo "## REFUSED: MAX_HOURS must be 1..168"; exit 9; }
(cd $R8 && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: r8 != SHA256SUMS"; exit 9; }
source $P/composite-mdbx-validation-stage/r6/jobs/common.sh        # the QUALIFIED r6 guards: pinned stages, live sessions, stage mounts
guards
if grep -qF '/composite-memory-fixture-stage/' /proc/self/mountinfo; then die "a memory-fixture stage mount exists"; fi
T=$(ls -d "$R8"/runs/tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$T" ] && python3 -I -B -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("pass") is True and r.get("stageSums")==sys.argv[2] else 1)' \
  "$T/receipt.json" "$(sha256sum < $R8/SHA256SUMS | cut -c1-64)" || die "no passing cmv-r8-tests receipt for these SUMS"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
O=$R8/runs/prod-$ID; J=$R8/runs/job-$ID                            # the gate's run dir must start EMPTY: job files live in J
mkdir -p "$R8/runs" && chmod 0700 "$R8/runs" && mkdir -m 0700 "$O" && mkdir -m 0700 "$J" || die "run dir"
peer_snapshot > $J/peers-before.txt
LIMIT=$((HOURS * 3600 + 1800))
( ulimit -f 32768; exec timeout -s TERM -k 600 $LIMIT python3 -I -B $R8/memory_gate.py gate --view-dir "$VIEW" --run-dir "$O" \
    --max-hours "$HOURS" --tree-root-pid $$ ) > $J/stdout.txt 2> $J/stderr.txt; rc=$?
peer_snapshot > $J/peers-after.txt
grep -F "$O" /proc/self/mountinfo > $J/mounts-left.txt
pgrep -u "$(id -u)" -a -f "$O" | grep -v -F "pgrep" > $J/processes-left.txt   # diagnostic only: nothing is signalled
python3 -I -B - "$O" "$J" "$rc" <<'PY' > $J/receipt.json; jrc=$?
import json, pathlib, sys
O, J, rc = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
r = json.loads((O / "session" / "receipt.json").read_text()) if (O / "session" / "receipt.json").exists() else {}
killed, termed = rc in (137, 128 + 9), rc == 124
checks = {"rc0": rc == 0, "clean": r.get("outcome") == "CLEAN", "cleanupComplete": r.get("cleanupComplete") is True,
          "peersUnchanged": (J / "peers-before.txt").read_text() == (J / "peers-after.txt").read_text(),
          "noMountLeft": (J / "mounts-left.txt").read_text() == "", "noProcessLeft": (J / "processes-left.txt").read_text() == ""}
rec = {"format": "composite-production-memory-job-receipt/r8", "structurallyCleanRun": all(checks.values()), "checks": checks, "rc": rc,
       "runtimeKilled": killed, "wrapperTerm": termed, "outcome": ("CLEANUP-INCOMPLETE (runtime killed by the wrapper)" if killed else r.get("outcome")),
       "reasons": r.get("reasons"), "memoryPeaks": (r.get("memory") or {}).get("peaks"), "softStop": (r.get("memory") or {}).get("softStop"),
       "memoryDirty": (r.get("memory") or {}).get("memoryDirty"), "mountsLeft": (J / "mounts-left.txt").read_text()[:4000],
       "processesLeft": (J / "processes-left.txt").read_text()[:4000],
       "meaning": "CLEAN = mdbx_chk structural check only; not chain/state/trie/canonical-root/RPC validation, not a production acceptance"}
print(json.dumps(rec, indent=1, sort_keys=True, default=str)); sys.exit(0 if rec["structurallyCleanRun"] else 1)
PY
cat $J/receipt.json; [ -s $J/mounts-left.txt ] && echo "## MOUNT LEFT under $O: stop and inspect (never re-run over it)"
echo "## gate/runtime $O ; job $J"; echo "## cmv-r8-prod rc=$rc (0 CLEAN structural only, 2 PROBLEMS, 3 REFUSED, 4 CLEANUP-INCOMPLETE, 5 CANCELLED/soft stop, 7 INCONCLUSIVE, 8 VOID, 124 TERM, 137 KILL)"
exit $rc
