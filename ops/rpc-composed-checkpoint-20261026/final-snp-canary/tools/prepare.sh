#!/usr/bin/env bash
# prepare (ONE queue job, 512): stage the 10cdf913 tree (tools/stage-tree.sh), the canary's own narrow offline tests
# (tools/unit-checks.sh: fake QEMU only, disposable transient scopes, no network), and only if both pass freeze FROZEN-PINS.json
# and run the read-only preflight (tools/freeze-and-preflight.sh). No QEMU, no VM, no SSH, no production process signalled.
set -uo pipefail
D=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$D/tmp"
echo "== stage-tree"; bash "$D/tools/stage-tree.sh" || { echo "PREPARE FAIL: stage-tree"; exit 1; }
echo "== unit-checks"; bash "$D/tools/unit-checks.sh" || { echo "PREPARE FAIL: unit-checks"; exit 1; }
echo "== freeze + preflight"; bash "$D/tools/freeze-and-preflight.sh" || { echo "PREPARE FAIL: freeze/preflight"; exit 1; }
rmdir "$D/tmp" 2>/dev/null || true
echo "PREPARE-OK"
