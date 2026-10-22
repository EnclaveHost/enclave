#!/bin/bash
# when-capacity.sh <label> <cmd...>: wait (foreground, at most 20 min) until MemAvailable >= 18 GiB, then run
# run-bounded.sh <label> <cmd...>. Exits 98 if capacity never came.
start_kb=$((18 * 1024 * 1024))
for _ in $(seq 1 80); do
  if [ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -ge "$start_kb" ]; then
    exec "$(dirname "$0")/run-bounded.sh" "$@"
  fi
  sleep 15
done
echo "# capacity did not reach 18 GiB within 20 min"; exit 98
