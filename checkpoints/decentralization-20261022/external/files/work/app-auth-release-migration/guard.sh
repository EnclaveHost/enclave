#!/bin/bash
# guard.sh MEM_MIB START_MIB [WAIT_SECS] -- command...
# One capped, swapless job as a transient systemd user unit (so systemd reports its PEAK memory). Waits in the foreground,
# at most WAIT_SECS, until MemAvailable >= START_MIB; never starts below it and never below the 16 GiB floor.
set -u
mem=$1; start=$2; shift 2
wait=600; [ "$1" != "--" ] && { wait=$1; shift; }; shift
floor=16384; [ "$start" -lt $floor ] && start=$floor
t0=$(date +%s)
while :; do
  avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  [ "$avail" -ge "$start" ] && break
  [ $(( $(date +%s) - t0 )) -ge "$wait" ] && { echo "guard: MemAvailable ${avail}MiB stayed below ${start}MiB for ${wait}s; not started"; exit 99; }
  sleep 10
done
s=$(date +%s)
out=$(systemd-run --user --wait --pipe --collect --same-dir -p MemoryMax=${mem}M -p MemorySwapMax=0 \
  -E PATH -E HOME -E CARGO_BUILD_JOBS=1 -E CARGO_INCREMENTAL=0 -E RUSTUP_TOOLCHAIN -E EYESOFF_WASM -E JOT_WASM -E DEPOT_WASM -E MCP_WASM \
  -E JOT_SCRATCH -E MIG_WORK -E CHROMIUM -- "$@" 2>&1; echo "__rc=$?")
rc=${out##*__rc=}; printf '%s\n' "${out%__rc=*}"
echo "guard: exit $rc after $(( $(date +%s) - s ))s (cap ${mem}MiB, start >= ${start}MiB, MemAvailable at start ${avail}MiB, now $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)MiB)"
exit $rc
