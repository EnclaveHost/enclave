#!/bin/bash
# state-fixture-capture-stage/r1: capture ONE frozen r11 compiled-fixture script run (PREPARED by Claude 1877; NOT run by Claude). MANUAL ONLY,
# root, after: all 265 parts CONFIRMED, r11 guard-tests + ns-tests PASS, a VERIFIED r11 build receipt (finalRc 0) naming BUILD_OUT_DIR:
#   bash jobs/q-exit-status.sh sfc-r1-positive 512 bash state-fixture-capture-stage/r1/jobs/run.sh positive /vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out
#   bash jobs/q-exit-status.sh sfc-r1-fixtures 512 bash state-fixture-capture-stage/r1/jobs/run.sh fixtures /vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out
# The 512 MiB lane (capture.py checks memory.max == 512 MiB and MemAvailable >= 16 GiB + 768 MiB). capture.py runs INSIDE `unshare -Urnm`
# (exact uid/gid maps and private propagation re-checked), re-checks every gate, spawns the frozen script itself through the pinned r11
# run_capture and writes <BUILD_OUT_DIR>/fixture-captures/<kind>-<UTC>-<pid>/{capture.txt,receipt.json} on /vm.
# Exit: 0 receipt pass true | 4 ran, failed (receipt pass false) | 3 refused, nothing ran | 9 this stage != SHA256SUMS / bad args.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
K=${1:?positive|fixtures}; BD=${2:?BUILD_OUT_DIR}
case "$K" in positive|fixtures) ;; *) echo "kind must be positive or fixtures"; exit 9;; esac
case "$BD" in /vm/enclave-volumes/rpc-recovery-validation-build/run-*/out) ;; *) echo "BUILD_OUT_DIR must be a /vm guard run out dir"; exit 9;; esac
U=$(id -u); G=$(id -g)
unshare -Urnm env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/capture.py" run "$K" "$BD" --uid "$U" --gid "$G"; rc=$?
echo "## sfc-r1-$K rc=$rc"; exit $rc
