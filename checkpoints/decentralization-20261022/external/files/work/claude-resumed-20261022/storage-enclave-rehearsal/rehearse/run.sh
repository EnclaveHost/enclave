#!/bin/bash
# ROOT ONLY, NOT RUN BY CLAUDE. One rehearsal run, AFTER the tool pins are filled and root reviewed the manifest:
#   work/claude-resumed-20261022/storage-enclave-rehearsal/rehearse/run.sh <manifest> <unique-log>
# ONE shared-queue job (512 MiB) entering a fresh user+network namespace (loopback only), exactly as the original run.sh.
# Docker (outside the queue): PostgreSQL 256m + one tool container at a time 256m => 1024 MiB in total.
# Exit 98 (the queue did not start the job) is NOT retried here: re-invoke deliberately. 99 = killed. Neither is a pass.
set -u
H=$(cd "$(dirname "$0")" && pwd); W=$(cd "$H/../../.." && pwd)
m=${1:?manifest} log=${2:?unique log}
[ -e "$log" ] && { echo "refusing: $log exists"; exit 2; }
exec python3 "$W/claude-test-queue.py" --mib 512 --log "$log" -- env RH_UID="$(id -u)" RH_GID="$(id -g)" \
  taskset -c 0-1 unshare --user --map-root-user --net -- sh -c 'ip link set lo up && exec python3 -u "$0" --execute "$1"' "$H/rehearse-c2.py" "$m"
