#!/bin/bash
# recovery-multipart-stage/r3 PRODUCTION preservation copy / verify (PREPARED by Claude 1748; NOT run by Claude; NOT authorized yet:
# no go-ahead, no capacity). Root only after: both test receipts of THIS frozen stage pass (unit 31, e2e 7), review, a root-written
# preservation request (orchestrate.py format) and root-created EMPTY 0700 target dirs on / and /vm, with capacity for the FULL
# reservation + 40 GiB floor each (admission refuses otherwise).
#   bash jobs/q-exit-status.sh rmp-r3-prod 1024 bash recovery-multipart-stage/r3/jobs/root-preservation.sh REQUEST REQUEST_SHA256 MANIFEST MANIFEST_SHA256 copy|verify [FIRST-LAST]
# NOT under unshare (FUSE). The original is only ever the read-only qcow2 backing of the r9 session on its read-only mount.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh   # r9 pins + guards()
guards
REQ=${1:?REQUEST}; REQ_SHA=${2:?REQUEST_SHA256}; MAN=${3:?MANIFEST}; MAN_SHA=${4:?MANIFEST_SHA256}; MODE=${5:?copy|verify}; PARTS=${6:-}
case "$MODE" in copy|verify) ;; *) die "MODE must be copy or verify";; esac
M=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$M" && sha256sum -c --quiet SHA256SUMS) || die "multipart r3 != SHA256SUMS"
SUMS=$(sha256sum < "$M/SHA256SUMS" | cut -c1-64)
python3 -I -B - "$M" "$SUMS" <<'PY' || die "no PASSING unit AND e2e receipts of this frozen stage"
import glob, json, sys
ok = {"unit": False, "e2e": False}
for p in glob.glob(sys.argv[1] + "/runs/*/receipt.json"):
    try:
        r = json.load(open(p))
    except (OSError, ValueError):
        continue
    if r.get("format") == "recovery-multipart-test-receipt/r3" and r.get("pass") is True and r.get("stageSums") == sys.argv[2] and r.get("suite") in ok:
        ok[r["suite"]] = True
sys.exit(0 if all(ok.values()) else 1)
PY
PARENT=/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2
findmnt -rn -o OPTIONS --target "$PARENT" | tr ',' '\n' | grep -qx ro || die "the original's mount is not read-only"
[ ! -w "$PARENT" ] || die "the original is writable by this user"
O=$M/runs/prod-$MODE-$(date -u +%Y%m%dT%H%M%SZ)-$$
peer_snapshot > "$M/runs/peers-before-$(basename "$O").txt"
env -i PATH=$PATH LC_ALL=C timeout -k 300 90000 python3 -I -B "$M/orchestrate.py" run --request "$REQ" --request-sha256 "$REQ_SHA" \
  --manifest "$MAN" --manifest-sha256 "$MAN_SHA" --run-dir "$O" --mode "$MODE" ${PARTS:+--parts "$PARTS"}; rc=$?
peer_snapshot > "$M/runs/peers-after-$(basename "$O").txt"
cmp -s "$M/runs/peers-before-$(basename "$O").txt" "$M/runs/peers-after-$(basename "$O").txt" || { echo "## PEER MOUNTS/PROCESSES CHANGED: inspect"; [ $rc = 0 ] && rc=4; }
grep -qF "$O" /proc/self/mountinfo && { echo "## a mount of this run survived"; rc=4; }
echo "## outputs $O"; echo "## rmp-r3-prod-$MODE rc=$rc (0 done + session CONFIRMED; 3 refused; 4 failed/UNCONFIRMED; 5 stopped)"; exit $rc
