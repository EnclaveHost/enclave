#!/bin/bash
# run-ns.sh <run-id>: run interop.py in a PRIVATE network namespace (loopback only: no public Sia, RPC or live storage is
# reachable) and a PRIVATE PID namespace (every process of the run dies when the driver exits), as uid 1000 inside a
# nested user namespace (PostgreSQL refuses to run as root). Run it inside ONE claude-test-queue allocation.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
id=${1:?run-id}
[[ "$id" =~ ^[a-z0-9]{1,12}$ ]] || { echo "run-id: [a-z0-9]{1,12}"; exit 2; }
exec unshare -rn --pid --fork --kill-child --mount-proc sh -c \
  'ip link set lo up && exec unshare -U --map-user=1000 --map-group=1000 python3 -u -B "$0" "$1"' "$here/interop.py" "$id"
