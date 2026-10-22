#!/bin/bash
# guard.sh MEM_MIB START_FLOOR_GIB -- command...   one capped, swapless, single-job run; refuses to start below the floor
set -u
mem=$1; floor=$2; shift 3
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "$avail" -lt $((floor*1024)) ]; then echo "guard: MemAvailable ${avail}MiB < ${floor}GiB, not started"; exit 99; fi
export CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
start=$(date +%s)
systemd-run --user --scope --quiet -p MemoryMax=${mem}M -p MemorySwapMax=0 -- "$@"
rc=$?
echo "guard: exit $rc after $(( $(date +%s) - start ))s (cap ${mem}MiB, MemAvailable at start ${avail}MiB, now $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)MiB)"
exit $rc
