#!/bin/bash
# usage: run-bounded.sh <logname> <command...>   (run from the main sia-s3 worktree)
# One scope: MemoryMax=1024M, no swap, CARGO_BUILD_JOBS=1. A 1 s watchdog stops only this scope if host
# MemAvailable < 16 GiB. Records MemAvailable at start, cgroup memory.peak and memory.events.
L=/home/steven/Documents/Codex/2026-10-18/wo/work/storage-integration-logs/$1.log; shift
UNIT=sias3-integ-$$-$RANDOM
echo "== $(date -Is) MemAvailable_kB=$(awk '/MemAvailable/{print $2}' /proc/meminfo) cmd: $*" > "$L"
systemd-run --user --scope -q --unit=$UNIT -p MemoryMax=1024M -p MemorySwapMax=0 env CARGO_BUILD_JOBS=1 bash -c '
  "$@"; rc=$?; d=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
  echo "peak_bytes=$(cat $d/memory.peak)"; grep -E "^(max|oom|oom_kill) " $d/memory.events | tr "\n" " "; echo; exit $rc' _ "$@" >> "$L" 2>&1 &
PID=$!
while kill -0 $PID 2>/dev/null; do
  a=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  if [ "$a" -lt 16777216 ]; then echo "WATCHDOG: MemAvailable_kB=$a < 16 GiB; stopping own scope" >> "$L"; systemctl --user stop $UNIT.scope; fi
  sleep 1
done
wait $PID; rc=$?; echo "exit=$rc" >> "$L"; exit $rc
