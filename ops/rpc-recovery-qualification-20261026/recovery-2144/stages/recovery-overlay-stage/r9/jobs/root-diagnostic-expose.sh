#!/bin/bash
# recovery-overlay-stage/r9 DIAGNOSTIC read-only exposure (prepared by Claude 1707; NOT run by Claude). NOT an acceptance path: the
# strict GO path (root-expose-real.sh) is unchanged. Authorized ONLY by a root-written request (diagnostic_request.py format
# recovery-overlay-diagnostic-request/v1: recoveryAccepted=false, productionUse=false, purpose full-readonly-mdbx-validation) bound to
# the pinned offline plan, the journal, the BLOCKED post-deletion history result (root 1698) and the pinned validator.
# It exposes the ORIGINAL qcow2 READ-ONLY as the tested disposable <= 64 MiB metadata overlay (r7 overlay_session.py, unchanged) and
# runs ONLY diag/run_validator.py -> the pinned mdbx_check.py -> the pinned mdbx_chk -v on the read-only view of /data/db.
# The result is a DIAGNOSTIC structural report: never a recovery, data-integrity, history or production claim.
#   bash jobs/q-exit-status.sh rov-r9-diag 4096 bash recovery-overlay-stage/r9/jobs/root-diagnostic-expose.sh REQUEST REQUEST_SHA256 [VALIDATOR_TIMEOUT]
# VALIDATOR_TIMEOUT 60..84600 s (default 84600; the session's own exec deadline is 86400 s; the job's outer timeout 90000 + 300).
# Not under unshare (host fusermount3). Never a read-write mount, a guest boot, a write to the original, or a peer's mount/process.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh
REQ=${1:?REQUEST}; REQ_SHA=${2:?REQUEST_SHA256}; VT=${3:-84600}
guards; mdbx_guards
case "$VT" in ''|*[!0-9]*) die "VALIDATOR_TIMEOUT must be an integer";; esac
[ "$VT" -ge 60 ] && [ "$VT" -le 84600 ] || die "VALIDATOR_TIMEOUT must be 60..84600"
# the pinned offline plan (root 1706, r7 overlay_plan.py = r8 byte-identical), journal and BLOCKED history (root 1698)
PLAN=$P/recovery-overlay-stage/r7/runs/plan-real-20261026T212534Z-2371806; PLAN_SHA=c4e38213847793d5c0868825fe454c5702b4499a6b25315078037b073a4f35a9
JSHA=d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073
HIST=$P/postdelete-bitmap-stage/r2/runs/check-20261026T211719Z-2363068/result.json; HIST_SHA=25abe05e6eb9e7bc7183552ad22bf7a466e080ed69437b33e0630f01d11196a7
[ "$(sha256sum < $PLAN/plan.json | cut -c1-64)" = $PLAN_SHA ] || die "the pinned plan changed"
cmp -s $P/recovery-overlay-stage/r7/overlay_plan.py $S/overlay_plan.py || die "overlay_plan.py differs from r7 (the plan's producer)"
PARENT=/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2
findmnt -rn -o OPTIONS --target "$PARENT" | tr ',' '\n' | grep -qx ro || die "the original's mount is not read-only"
[ ! -w "$PARENT" ] || die "the original is writable by this user"
O=$S/runs/diag-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $O && chmod 0700 $S/runs $O || die "run dir"
env -i PATH=$PATH LC_ALL=C python3 -I -B $S/diagnostic_request.py --request "$REQ" --request-sha256 "$REQ_SHA" --plan-sha256 $PLAN_SHA \
  --journal-sha256 $JSHA --history $HIST --history-sha256 $HIST_SHA --chk-sha256 $CHK_SHA --wrapper-sha256 $CHECK_PY_SHA > $O/authorization.json \
  || { cat $O/authorization.json; die "the diagnostic request is not authorized"; }
cp "$REQ" $O/request.json
peer_snapshot > $O/peers-before.txt
env -i PATH=$PATH LC_ALL=C timeout -k 300 90000 python3 -I -B $S/overlay_session.py --plan-dir $PLAN --plan-sha256 $PLAN_SHA --parent "$PARENT" \
  --run-dir $O --require-ro-mount --fuse2fs $FUSE2FS --fuse2fs-sha256 $FUSE2FS_SHA --exec-timeout 86400 \
  --exec /usr/bin/python3 -I -B $S/diag/run_validator.py --check-py $CHECK_PY --check-py-sha256 $CHECK_PY_SHA \
  --chk $MDBX_BIN/mdbx_chk --chk-sha256 $CHK_SHA --timeout $VT --out $O/mdbx-report.json; rc=$?
peer_snapshot > $O/peers-after.txt
cmp -s $O/peers-before.txt $O/peers-after.txt || { echo "## PEER MOUNTS/PROCESSES CHANGED: inspect (not touched by this job)"; [ $rc = 0 ] && rc=4; }
grep -qF "$O" /proc/self/mountinfo && { echo "## a mount of this run survived"; rc=4; }
python3 -I - "$O" "$rc" <<'PY' > $O/diagnostic-summary.json
import json, os, sys
O, rc = sys.argv[1], int(sys.argv[2])
def rj(p):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None
rep, rec, auth = rj(f"{O}/mdbx-report.json"), rj(f"{O}/receipt.json") or {}, rj(f"{O}/authorization.json") or {}
print(json.dumps({"kind": "DIAGNOSTIC", "recoveryAccepted": False, "productionUse": False, "historyVerdict": auth.get("historyVerdict"),
    "label": auth.get("label"), "sessionRc": rc, "cleanupComplete": rec.get("cleanupComplete"), "parentUnchanged": rec.get("parentUnchanged"),
    "mdbx": None if rep is None else {k: rep.get(k) for k in ("rc", "result", "structurallyClean", "seconds", "timedOut", "unchangedIdentity", "notChecked")},
    "meaning": "structurallyClean=true means only that the pinned mdbx_chk found no structural problem in the read-only view; "
               "the history stays BLOCKED, value bytes, chain state and recovery are NOT established"}, indent=1))
PY
cat $O/diagnostic-summary.json
echo "## outputs $O"; echo "## rov-r9-diag rc=$rc (0 mdbx_chk structurally clean - DIAGNOSTIC ONLY; 6 not clean/timeout/refused validator; 1 check failed; 3 refused; 4 cleanup/peer problem: STOP; 5 interrupted)"; exit $rc
