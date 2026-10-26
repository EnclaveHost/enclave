#!/bin/bash
# recovery-overlay-stage/r9 REAL read-only recovery VIEW (prepared by Claude 1660/1674; NOT run by Claude). ONLY after root's transient-reuse
# gate (6d 1659) passed AND root wrote a GO file (B3, da 1671): {"format": "recovery-overlay-go/v1", "pass": true, "planSha256": <the
# rov-r9-plan plan.json sha256>, "journalSha256": "d95d81fc...", "gateReceiptSha256": <the 1659 receipt sha256>} whose sha256 is passed too. Reads the ORIGINAL qcow2 READ-ONLY (backing of a NEW <= 64 MiB overlay in
# this stage's runs/); exposes /data/db/mdbx.dat through our own qemu-nbd -r / nbdfuse -r / fuse2fs ro,norecovery; runs the checks,
# then either --hold-seconds N (stop early with: touch RUN/STOP) or -- VALIDATOR ARGS... (RECOVERY_TARGET=<path>); always cleans up.
#   bash jobs/q-exit-status.sh rov-r9-expose 512 bash recovery-overlay-stage/r9/jobs/root-expose-real.sh PLAN_DIR PLAN_SHA256 GO_FILE GO_SHA256 [--hold-seconds N | -- CMD...]
# Never cd a shell into the mount (EBUSY at cleanup): inspect only through the validator or STOP.
# Not under unshare (host fusermount3). Never a read-write mount, a guest boot, a write to the original, or a peer's mount/process.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh
PLAN=${1:?PLAN_DIR}; PLAN_SHA=${2:?PLAN_SHA256}; GO=${3:?GO_FILE}; GO_SHA=${4:?GO_SHA256}; shift 4
guards
case "$PLAN" in $S/runs/plan-real-*) ;; *) die "PLAN_DIR must be a plan-real run of this stage";; esac
[ -f "$GO" ] && [ ! -L "$GO" ] && [ "$(sha256sum < "$GO" | cut -c1-64)" = "$GO_SHA" ] || die "the GO file is missing or not the pinned sha256"
[ "$(sha256sum < $PLAN/plan.json | cut -c1-64)" = "$PLAN_SHA" ] || die "plan.json is not the pinned sha256"
python3 -I - "$GO" "$PLAN_SHA" <<'PY' || die "the GO file does not pass this exact plan and journal"
import json, re, sys
with open(sys.argv[1]) as f:
    g = json.load(f)
ok = (g.get("format") == "recovery-overlay-go/v1" and g.get("pass") is True and g.get("planSha256") == sys.argv[2]
      and g.get("journalSha256") == "d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073"
      and re.fullmatch(r"[0-9a-f]{64}", str(g.get("gateReceiptSha256"))) is not None)
sys.exit(0 if ok else 1)
PY
PARENT=/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2
findmnt -rn -o OPTIONS --target "$PARENT" | tr ',' '\n' | grep -qx ro || die "the original's mount is not read-only"
[ ! -w "$PARENT" ] || die "the original is writable by this user"
O=$S/runs/expose-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $O && chmod 0700 $O || die "run dir"
cp "$GO" $O/go.json; sha256sum $PLAN/plan.json > $O/plan.sha256
peer_snapshot > $O/peers-before.txt
EXTRA=(); if [ "${1:-}" = "--hold-seconds" ]; then EXTRA=(--hold-seconds "${2:?N}"); elif [ "${1:-}" = "--" ]; then shift; EXTRA=(--exec "$@"); fi
env -i PATH=$PATH LC_ALL=C timeout -k 300 90000 python3 -I -B $S/overlay_session.py --plan-dir $PLAN --plan-sha256 $PLAN_SHA --parent "$PARENT" \
  --run-dir $O --require-ro-mount --fuse2fs $FUSE2FS --fuse2fs-sha256 $FUSE2FS_SHA "${EXTRA[@]}"; rc=$?
peer_snapshot > $O/peers-after.txt
cmp -s $O/peers-before.txt $O/peers-after.txt || { echo "## PEER MOUNTS/PROCESSES CHANGED: inspect (not touched by this job)"; [ $rc = 0 ] && rc=4; }
grep -q "$O" /proc/self/mountinfo && { echo "## a mount of this run survived"; rc=4; }
echo "## outputs $O"; echo "## rov-r9-expose rc=$rc (0 pass; 1 check failed; 3 refused; 4 cleanup/peer problem: STOP; 5 interrupted; 6 validator failed)"; exit $rc
