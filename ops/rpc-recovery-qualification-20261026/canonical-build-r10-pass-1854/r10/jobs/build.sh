#!/bin/bash
# base-state-readonly-stage/r10 INNER build (PREPARED by Claude 1728/1839/1844; NOT run by Claude). Started ONLY by jobs/bsro_gate.py outer as
#   unshare -Urnm bash jobs/build.sh build|preflight OUTER_UID OUTER_GID COMPLETION_FINGERPRINT
# r7 checks kept (stage SUMS, r5 guard bytes, qualifying receipts - now the r10 guard-tests AND ns-tests receipts -, /vm mount identity),
# then (plan 1837 §4c; r9 PB1: RECURSIVE read-only, verified for every visible mount below): jobs/ns.sh makes mount propagation PRIVATE
# and binds /home/steven and /tmp READ-ONLY in this namespace
# only (specific enforcement: the cached crate store, the rustup home, the stage and root runs/ and tmpfs cannot be written by the build;
# /vm stays writable; other paths such as /var are NOT covered); then the inner gate (exact uid/gid maps, private propagation, the
# read-only checks, the completion fingerprint recomputed == the outer one). The disk guard command is r7's, byte for byte, with the inner
# script chosen by MODE (build-inner.sh / preflight.sh). A TERM/INT/HUP trap (a handler, not SIG_IGN) keeps this shell until the guard has
# stopped its build group, so the exit code propagates.
# m4: the trap is installed only after the early checks, ns_harden and the inner gate; a TERM during those ends this shell at once
# (rc 143, preserved as nonzero by the outer): NOTHING has started then - no guard, no build, no write outside this namespace's mounts.
set -uo pipefail
export PATH=/usr/bin:/bin
MODE=${1:-}; OUID=${2:-}; OGID=${3:-}; FP=${4:-}
case "$MODE" in build) INNER=build-inner.sh;; preflight) INNER=preflight.sh;; *) echo "## REFUSED: mode must be build|preflight"; exit 9;; esac
[[ "$OUID" =~ ^[0-9]+$ && "$OGID" =~ ^[0-9]+$ && "$FP" =~ ^[0-9a-f]{64}$ ]] || { echo "## REFUSED: OUTER_UID OUTER_GID FINGERPRINT"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P)
BASE=/vm/enclave-volumes/rpc-recovery-validation-build
VM_UUID=aaae081c-f829-4484-a50f-a9bbb87d31f9; VM_SRC=/dev/mapper/cryptvm; VM_FS=ext4; VM_MM=253:1     # read-only findmnt, 1728
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
SUMS=$(sha256sum < "$S/SHA256SUMS" | cut -c1-64)
R5SUMS=71e5fac4008a1776271cb83434311d6ece1621c8cdf0f29f3ba8edf9471c988f     # r6: the qualified guard runtime must be r5's, byte for byte
[ "$(sha256sum < "$S/../r5/SHA256SUMS" | cut -c1-64)" = "$R5SUMS" ] && (cd "$S/../r5" && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: frozen r5 changed"; exit 9; }
for f in jobs/disk_guard.py tests/test_disk_guard.py tests/guard_wrapper.py; do cmp -s "$S/$f" "$S/../r5/$f" || { echo "## REFUSED: $f differs from r5 (guard runtime must be unchanged)"; exit 9; }; done
python3 -I -B "$S/jobs/bsro_gate.py" qualified || { echo "## REFUSED: no passing r10 guard-tests + ns-tests receipts for this frozen stage"; exit 9; }
# r7 (root 1735: findmnt pads with trailing spaces; r5/r6's `tr -s ' '` string compare always refused): exactly one line, exactly 4
# fields, each compared individually; anything else refuses (fail closed)
python3 -I -B "$S/jobs/mount_identity.py" --target /vm/enclave-volumes --uuid "$VM_UUID" --source "$VM_SRC" --fstype "$VM_FS" --majmin "$VM_MM" \
  || { echo "## REFUSED: /vm is not the pinned device"; exit 9; }
source "$S/jobs/ns.sh"
ns_harden /home/steven /tmp || { echo "## REFUSED: namespace hardening failed"; exit 9; }
DEPS=$P/derivation-client-stage/combined-r1/build/deps-43698236e9186750
python3 -I -B "$S/jobs/bsro_gate.py" inner-gate --uid "$OUID" --gid "$OGID" --fingerprint "$FP" --ro "$S" --ro "$DEPS/cargo" \
  --ro /home/steven/.rustup --ro /home/steven/.cargo --ro /tmp --rw "$BASE" || { echo "## REFUSED: inner gate"; exit 9; }
trap ':' TERM INT HUP
python3 -I -B "$S/jobs/disk_guard.py" --base "$BASE" --mount-majmin $VM_MM --mount-source $VM_SRC --mount-fstype $VM_FS \
  --min-start-gib 64 --floor-gib 40 --max-scratch-gib 20 --interval 15 --timeout 7500 -- bash "$S/jobs/$INNER"; rc=$?
echo "## bsro-r10-$MODE rc=$rc (child rc; 3 refused; 70 /vm < 40 GiB; 71 scratch > 20 GiB; 72 timeout; 73 cancelled; 9 precondition)"; exit $rc
