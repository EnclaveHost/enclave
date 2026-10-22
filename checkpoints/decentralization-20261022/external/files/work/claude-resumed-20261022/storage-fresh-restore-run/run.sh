#!/bin/bash
# ROOT ONLY, NOT RUN BY CLAUDE. ONE fresh-restore rehearsal run of backup 20261022T075011Z-bee519f1, after
# `fresh_rehearsal.py --plan` (queue 256) exits 0 and root reviewed its manifest:
#   work/claude-resumed-20261022/storage-fresh-restore-run/run.sh <manifest> <unique-log>
# Identical shape to storage-enclave-rehearsal/rehearse/run.sh (54185b5c): ONE shared-queue job (512 MiB), a fresh
# user+network namespace (loopback only); docker outside the queue: PostgreSQL 256m + one tool container 256m.
# Exit 98 (not started) is NOT retried here; 99 = killed. Neither is a pass.
set -u
H=$(cd "$(dirname "$0")" && pwd); W=$(cd "$H/../.." && pwd)
m=${1:?manifest} log=${2:?unique log}
[ -e "$log" ] && { echo "refusing: $log exists"; exit 2; }
exec python3 "$W/claude-test-queue.py" --mib 512 --log "$log" -- env RH_UID="$(id -u)" RH_GID="$(id -g)" \
  taskset -c 0-1 unshare --user --map-root-user --net -- sh -c 'ip link set lo up && exec python3 -u "$0" --execute "$1"' "$H/fresh_rehearsal.py" "$m"
