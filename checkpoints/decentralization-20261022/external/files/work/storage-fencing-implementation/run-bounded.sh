#!/bin/bash
# run-bounded.sh <label> <command...>   (CAP=512M etc. to lower the cap; default 1024M)
# One cargo job in its own systemd scope: MemoryMax=1024M, no swap, CARGO_BUILD_JOBS=1. A watchdog stops ONLY this
# scope if the host's MemAvailable drops below 16 GiB, and records the scope's memory.peak every second.
set -u
label=$1; shift
unit="sia-fencing-$label-$$"
log="$(dirname "$0")/logs/$label.log"; cap=${CAP:-1024M}
floor_kb=$((16 * 1024 * 1024))
start_kb=$((18 * 1024 * 1024))
if [ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -lt "$start_kb" ]; then echo "# REFUSED to start: MemAvailable below 18 GiB"; exit 99; fi
: > "$log"
echo "# $(date -Is) label=$label unit=$unit MemAvailable_kB=$(awk '/MemAvailable/{print $2}' /proc/meminfo) cap=$cap swap=0 jobs=1" >> "$log"
echo "# cmd: $*" >> "$log"
systemd-run --user --scope --unit="$unit" -p MemoryMax=$cap -p MemorySwapMax=0 \
  env CARGO_BUILD_JOBS=1 "$@" >> "$log" 2>&1 &
pid=$!
peak=0; stopped=""
cg=""
while kill -0 $pid 2>/dev/null; do
  [ -z "$cg" ] && cg=$(systemctl --user show -p ControlGroup --value "$unit.scope" 2>/dev/null)
  if [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/memory.peak" ]; then
    p=$(cat "/sys/fs/cgroup$cg/memory.peak" 2>/dev/null || echo 0); [ "$p" -gt "$peak" ] 2>/dev/null && peak=$p
    oom=$(awk '/^oom_kill /{print $2}' "/sys/fs/cgroup$cg/memory.events" 2>/dev/null)
  fi
  avail=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  if [ "$avail" -lt "$floor_kb" ]; then
    stopped="host MemAvailable ${avail} kB below 16 GiB floor"
    systemctl --user stop "$unit.scope"
    break
  fi
  sleep 1
done
wait $pid; rc=$?
echo "# exit=$rc peak_MiB=$((peak / 1048576)) oom_kills=${oom:-0} ${stopped:+STOPPED: $stopped}" >> "$log"
tail -1 "$log"
exit $rc
