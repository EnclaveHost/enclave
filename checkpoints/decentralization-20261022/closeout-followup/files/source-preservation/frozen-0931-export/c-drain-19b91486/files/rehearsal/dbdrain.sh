#!/bin/bash
# dbdrain.sh <run-id>: extract the cutover.py of fbaecfce and 6fd7a929 (the negative controls) and run dbdrain.py in PRIVATE
# network + PID namespaces as uid 1000 (PostgreSQL refuses root). Run it inside ONE claude-test-queue allocation (768: one
# indexd at GOMEMLIMIT 256MiB, one small PostgreSQL, the client and the scripts; no hosts, no wasm).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
id=${1:?run-id}
[[ "$id" =~ ^[a-z0-9]{1,12}$ ]] || { echo "run-id: [a-z0-9]{1,12}"; exit 2; }
mkdir -p "$here/tmp" "$here/runs"
git -C "$here/.." show fbaecfced41da552a9e138082ecd0bd821c9e0f8:package/tools/cutover.py > "$here/tmp/cutover-fbaecfce.py"
git -C "$here/.." show 6fd7a9299c53121142ab59d8ff9a7406c1f2b845:package/tools/cutover.py > "$here/tmp/cutover-6fd7a929.py"
sha256sum "$here/dbdrain.py" "$here/tmp/cutover-fbaecfce.py" "$here/tmp/cutover-6fd7a929.py" "$here/../package/tools/cutover.py" \
  "$here/../package/primary/db-barrier.sh" "$here/../package/primary/vm-state.v2.sh"
export OLD_CUTOVER_FBA="$here/tmp/cutover-fbaecfce.py" OLD_CUTOVER_6FD="$here/tmp/cutover-6fd7a929.py"
exec unshare -rn --pid --fork --kill-child --mount-proc sh -c \
  'ip link set lo up && exec unshare -U --map-user=1000 --map-group=1000 python3 -u -B "$0" "$1"' "$here/dbdrain.py" "$id"
