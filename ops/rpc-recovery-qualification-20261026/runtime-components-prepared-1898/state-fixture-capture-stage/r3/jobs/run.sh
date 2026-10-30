#!/bin/bash
# state-fixture-capture-stage/r3: capture ONE frozen r12 compiled-fixture script run (PREPARED by Claude 1879/1889; NOT run by Claude). MANUAL ONLY,
# root, after: all 265 parts CONFIRMED, r12 guard-tests + ns-tests PASS, a VERIFIED r12 build receipt (finalRc 0) naming BUILD_OUT_DIR, AND
# r3: the parser is BOUND (acceptance r3 SUMS 1e7eb636..., module b2c10534..., root's actual 46-test receipt e2361fbb...):
#   bash jobs/q-exit-status.sh sfc-r3-positive 512 bash state-fixture-capture-stage/r3/jobs/run.sh positive /vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out
#   bash jobs/q-exit-status.sh sfc-r3-fixtures 512 bash state-fixture-capture-stage/r3/jobs/run.sh fixtures /vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out
# 1. OUTSIDE any namespace: `capture.py precheck` (every gate incl. no live session / stage mount) BEFORE ns_harden could clone a mount;
# 2. `unshare -Urnm bash jobs/inner.sh`: pinned r12 ns.sh -> ns_harden /home/steven /tmp + /var/tmp /dev/shm /run/user/UID when present (recursive read-only; /vm stays writable), then
#    `capture.py run` re-checks every gate + the namespace (maps, private propagation, ro_tree_ok) and runs the script with WORK on /vm.
# Exit: 0 receipt pass true | 4 ran, failed | 3 refused, nothing ran | 9 this stage != SHA256SUMS / bad args / hardening failed.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
[ $# = 2 ] || { echo "usage: run.sh positive|fixtures BUILD_OUT_DIR"; exit 9; }
K=$1; BD=$2
case "$K" in positive|fixtures) ;; *) echo "kind must be positive or fixtures"; exit 9;; esac
[[ "$BD" =~ ^/vm/enclave-volumes/rpc-recovery-validation-build/run-[0-9]{8}T[0-9]{6}Z-[0-9]+/out$ ]] || { echo "BUILD_OUT_DIR must be a /vm guard run out dir"; exit 9; }
env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/capture.py" precheck "$K" "$BD"; rc=$?
[ $rc = 0 ] || { echo "## sfc-r3-$K rc=$rc (precheck refused: nothing created, no namespace)"; exit $rc; }
U=$(id -u); G=$(id -g)
unshare -Urnm bash "$S/jobs/inner.sh" "$K" "$BD" "$U" "$G"; rc=$?
echo "## sfc-r3-$K rc=$rc"; exit $rc
