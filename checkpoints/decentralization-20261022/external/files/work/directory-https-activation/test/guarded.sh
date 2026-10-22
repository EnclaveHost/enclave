#!/usr/bin/env bash
# Run ONE foreground command in a transient user scope (MemoryMax=$MIB, MemorySwapMax=0) under the shared process-tree
# memory guard (work/enclave/test/helpers/memory-guard.mjs: tree RSS cap = $MIB, host floor 16 GiB).
#   test/guarded.sh <256|512> <log> -- command ...
# Start policy (coordinator's scoped authorization for THIS worker only, work/directory-https-activation/
# coordinator-reallocation.json, 2026-10-20): a 256 MiB job may start at MemAvailable >= 17408 MiB (17 GiB), a 512 MiB job
# at >= 17664 MiB (17.25 GiB). Host floor 16384 MiB, MemoryMax and no swap are unchanged. One job at a time.
# Waits at most START_WAIT_S (default 50 s, max 60) for the start threshold, then exits 98 without starting; never retries.
# The command's exit status is returned unmasked (the guard exits 99 when it stops the job).
set -euo pipefail
MIB=$1; LOG=$2; shift 2; [ "${1:-}" = "--" ] && shift
case "$MIB" in 256) START_MIB=17408;; 512) START_MIB=17664;; *) echo "allocation must be 256 or 512 MiB" >&2; exit 2;; esac
GUARD=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/memory-guard.mjs
WAIT=${START_WAIT_S:-50}; [ "$WAIT" -gt 60 ] && WAIT=60
deadline=$(( $(date +%s) + WAIT ))
while :; do
  avail=$(( $(awk '/MemAvailable/{print $2}' /proc/meminfo) / 1024 ))
  [ "$avail" -ge "$START_MIB" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "[guarded] NOT STARTED: MemAvailable ${avail} MiB < ${START_MIB} MiB" | tee -a "$LOG" >&2; exit 98; fi
  sleep 5
done
echo "[guarded] $(date -Is) start MemAvailable=${avail}MiB alloc=${MIB}MiB threshold=${START_MIB}MiB cmd=$*" >> "$LOG"
exec systemd-run --user --scope -q -p MemoryMax=${MIB}M -p MemorySwapMax=0 \
  node "$GUARD" --max-rss-mib "$MIB" --floor-available-mib 16384 --log "$LOG" -- "$@"
