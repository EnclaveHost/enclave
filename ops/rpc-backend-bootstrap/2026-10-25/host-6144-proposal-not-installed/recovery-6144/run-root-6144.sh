#!/bin/bash
# ROOT runner for ONE M10 6144 attempt (foreground). Usage: bash run-root-6144.sh <attempt 1-9>
# Refuses unless the SHARED queue file is the reviewed 6144 candidate (so every concurrent job uses the same 6144 large-lane
# accounting) and every receipt name for this attempt is new. The recorded rc is the queue's OWN exit code, captured
# directly (no pipeline, no wrapper that could report a false 0). Writes logs/resume-<N>.{out,guard,rc,receipt.json}.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work
M=$W/rpc-production-final-20261025/finality-stage/m10-bootstrap; R=$M/recovery-6144; Q=$W/claude-test-queue.py
N=${1:-}; [[ "$N" =~ ^[1-9]$ ]] || { echo "## REFUSED: attempt must be 1-9"; exit 2; }
QS=$(sha256sum < $Q | cut -c1-64)
[ "$QS" = fa0462030ad06c4c283de040cb17cbb2a3d648cc1963f581281b2ceb0b62c4e6 ] || { echo "## REFUSED: $Q ($QS) is not the reviewed 6144 candidate fa046203"; exit 2; }
for f in out guard rc receipt.json; do [ ! -e $R/logs/resume-$N.$f ] || { echo "## REFUSED: $R/logs/resume-$N.$f exists"; exit 2; }; done
S0=$(date -u +%FT%TZ); A0=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
echo "## attempt $N start $S0 MemAvailable ${A0}MiB (queue requires 24832 idle / 25088 with a small job)"
set -o noclobber
python3 $Q --mib 6144 --extra-start-mib 2048 --log $R/logs/resume-$N.guard -- \
  env CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-Wl,--threads=1' RESUME=$N unshare -rn bash $R/resume-6144.sh > $R/logs/resume-$N.out 2>&1
rc=$?
printf '%s\n' "$rc" > $R/logs/resume-$N.rc
python3 -I - "$R/logs" "$N" "$rc" "$S0" "$(date -u +%FT%TZ)" "$QS" "$A0" > $R/logs/resume-$N.receipt.json <<'PY'
import hashlib, json, pathlib, sys
d, n, rc, s0, s1, qs, a0 = sys.argv[1:]; d = pathlib.Path(d)
def h(p): return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
out = d / f"resume-{n}.out"; txt = out.read_text(errors="replace") if out.exists() else ""
print(json.dumps({"attempt": int(n), "queueExit": int(rc), "start": s0, "end": s1, "queueSha256": qs, "memAvailableAtLaunchMiB": int(a0),
                  "outSha256": h(out), "guardSha256": h(d / f"resume-{n}.guard"),
                  "aggregateLine": next((l for l in txt.splitlines() if l.startswith("## aggregate rc=")), None),
                  "guardLine": next((l for l in txt.splitlines() if l.startswith("[memory-guard] exit=")), None),
                  "pass": int(rc) == 0 and "## aggregate rc=0" in txt}, indent=1))
PY
echo "## attempt $N queue exit $rc (receipt logs/resume-$N.receipt.json)"; exit $rc
