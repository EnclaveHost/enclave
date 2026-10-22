#!/bin/bash
# The app-auth worker's bounded gate (app-auth-release-migration/scratch/eyesoff-candidate-build.sh), unchanged in its gate,
# cap and command; only the cargo target dir and the logs are this workspace's (their stale artifact stays untouched).
# Starts the EyesOff CANDIDATE production-profile build (cap 1536) only when >= 18944 MiB is available.
V=/home/steven/Documents/Codex/2026-10-18/wo/work/eyesoff-eab1-validation
cd /home/steven/Documents/Codex/2026-10-18/wo/work/app-auth-release-migration/scratch/apps/eyesoff-ai || exit 2
export CARGO_TARGET_DIR=$V/target
deadline=$(( $(date +%s) + ${GATE_SECS:-3600} ))
while :; do
  avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if [ "$avail" -ge 18944 ]; then
    out=$(python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log $V/logs/build.guard.log -- env CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo build --release --target wasm32-wasip2 --locked --offline 2>&1); rc=$?
    [ $rc -ne 98 ] && { echo "$out" > $V/logs/build.log; echo "rc=$rc avail_at_start=$avail at $(date -Iseconds)"; tail -5 $V/logs/build.log; sha256sum $V/target/wasm32-wasip2/release/eyesoff_ai.wasm; exit $rc; }
    echo "$(date -Iseconds) avail=$avail queue answered 98 (not started)"
  fi
  [ "$(date +%s)" -ge "$deadline" ] && { echo "NOT STARTED: available never reached 18944 MiB (or the queue never admitted it) within the gate window (last $avail at $(date -Iseconds))"; exit 97; }
  sleep 20
done
