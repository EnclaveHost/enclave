#!/bin/bash
# Bounded gate: start the EyesOff CANDIDATE production-profile build (cap 1536) only when >= 18944 MiB is available.
M=/home/steven/Documents/Codex/2026-10-18/wo/work/app-auth-release-migration
cd $M/scratch/apps/eyesoff-ai || exit 2
deadline=$(( $(date +%s) + ${GATE_SECS:-3600} ))
while :; do
  avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if [ "$avail" -ge 18944 ]; then
    out=$(python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log $M/logs/eyesoff-candidate-build.guard.log -- env CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo build --release --target wasm32-wasip2 --locked --offline 2>&1); rc=$?
    [ $rc -ne 98 ] && { echo "$out" > $M/logs/eyesoff-candidate-build.log; echo "rc=$rc avail_at_start=$avail"; tail -5 $M/logs/eyesoff-candidate-build.log; sha256sum target/wasm32-wasip2/release/eyesoff_ai.wasm; exit $rc; }
  fi
  [ "$(date +%s)" -ge "$deadline" ] && { echo "NOT STARTED: available never reached 18944 MiB within the gate window (last $avail)"; exit 97; }
  sleep 20
done
