#!/bin/bash
# recovery-overlay-stage/r1 REAL read-only recovery VIEW (prepared by Claude 1660; NOT run by Claude). ONLY after root's transient-reuse
# gate (6d 1659) passed; needs that gate's receipt file. Reads the ORIGINAL qcow2 READ-ONLY (backing of a NEW <= 64 MiB overlay in
# this stage's runs/); exposes /data/db/mdbx.dat through our own qemu-nbd -r / nbdfuse -r / fuse2fs ro,norecovery; runs the checks,
# then either --hold-seconds N (stop early with: touch RUN/STOP) or -- VALIDATOR ARGS... (RECOVERY_TARGET=<path>); always cleans up.
#   bash jobs/q-exit-status.sh rov-r1-expose 512 bash recovery-overlay-stage/r1/jobs/root-expose-real.sh PLAN_DIR GATE_RECEIPT [--hold-seconds N | -- CMD...]
# Not under unshare (host fusermount3). Never a read-write mount, a guest boot, a write to the original, or a peer's mount/process.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r1/jobs/common.sh
PLAN=${1:?PLAN_DIR}; GATE=${2:?GATE_RECEIPT}; shift 2
guards
case "$PLAN" in $S/runs/plan-real-*) ;; *) die "PLAN_DIR must be a plan-real run of this stage";; esac
[ -f "$GATE" ] && [ ! -L "$GATE" ] && [ -s "$GATE" ] || die "the transient-reuse gate receipt is required (root 1659): $GATE"
PARENT=/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2
findmnt -rn -o OPTIONS --target "$PARENT" | tr ',' '\n' | grep -qx ro || die "the original's mount is not read-only"
[ ! -w "$PARENT" ] || die "the original is writable by this user"
O=$S/runs/expose-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $O && chmod 0700 $O || die "run dir"
sha256sum "$GATE" > $O/gate.sha256; sha256sum $PLAN/plan.json > $O/plan.sha256
peer_snapshot > $O/peers-before.txt
EXTRA=(); if [ "${1:-}" = "--hold-seconds" ]; then EXTRA=(--hold-seconds "${2:?N}"); elif [ "${1:-}" = "--" ]; then shift; EXTRA=(--exec "$@"); fi
env -i PATH=$PATH LC_ALL=C timeout -k 30 90000 python3 -I -B $S/overlay_session.py --plan-dir $PLAN --parent "$PARENT" --run-dir $O \
  --fuse2fs $FUSE2FS --fuse2fs-sha256 $FUSE2FS_SHA "${EXTRA[@]}"; rc=$?
peer_snapshot > $O/peers-after.txt
cmp -s $O/peers-before.txt $O/peers-after.txt || { echo "## PEER MOUNTS/PROCESSES CHANGED: inspect (not touched by this job)"; [ $rc = 0 ] && rc=4; }
grep -q "$O" /proc/self/mountinfo && { echo "## a mount of this run survived"; rc=4; }
echo "## outputs $O"; echo "## rov-r1-expose rc=$rc (0 checks pass; 1 a check failed; 3 refused; 4 cleanup/peer problem: STOP)"; exit $rc
