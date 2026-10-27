#!/bin/bash
# compact-header-extraction-stage/r1 PRODUCTION extraction (prepared by Claude 1881; NOT run by Claude). MAIN LANE, coordinated, never automatic;
# NOT under unshare (FUSE). Only after unit + e2e PASS, review, and a root-written request:
#   python3 -I -B compact-header-extraction-stage/r1/extract.py request --stage-sums "$(sha256sum < compact-header-extraction-stage/r1/SHA256SUMS | cut -c1-64)" > REQ
#   (review REQ, keep it read-only)  bash jobs/q-exit-status.sh che-r1-extract 1024 bash compact-header-extraction-stage/r1/jobs/root-extract.sh REQ "$(sha256sum < REQ | cut -c1-64)"
# Output: a NEW /vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-<ts>-<pid>/ (files/, EXTRACTION-RECEIPT.json,
# session/receipt.json). rc 0 CLEAN; 3 refused; 4 failed (kept); 5 stopped (graceful stop: kill -TERM the extract.py pid, never the queue).
set -uo pipefail
[ $# = 2 ] || { echo "usage: root-extract.sh REQUEST REQUEST_SHA256"; exit 9; }
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh
guards                                                     # r9: not root, r9 SUMS, pinned fuse2fs/qemu tools, FUSE present
C=$P/compact-header-extraction-stage/r1
(cd $C && sha256sum -c --quiet SHA256SUMS) || die "compact-header-extraction-stage/r1 != SHA256SUMS"
SUMS=$(sha256sum < $C/SHA256SUMS | cut -c1-64)
[ -f "$1" ] && [ ! -L "$1" ] && [ ! -w "$1" ] || die "the request must be a read-only regular file"
O=$C/runs/extract-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p -m 0700 $C/runs && mkdir -m 0700 $O || die "run dir"
peer_snapshot > $O/peers-before.txt
python3 -I -B $C/jobs/coordination.py > $O/coordination.json 2> $O/coordination.err; crc=$?
cat $O/coordination.json $O/coordination.err
[ $crc = 0 ] || die "coordination refused (multipart busy or root floor): see $O/coordination.json"
read -r VMRES VMFLOOR < <(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["vmReserveBytes"], d["vmFloorBytes"])' $O/coordination.json) || die "coordination output"
python3 -I -B $C/extract.py run --dest-parent /vm/enclave-volumes/tr004-base-recovery-20261026 --request "$1" --request-sha256 "$2" \
  --stage-sums $SUMS --reserve-bytes $VMRES --floor-bytes $VMFLOOR > $O/extract.out 2> $O/extract.err; rc=$?
cat $O/extract.out; tail -20 $O/extract.err
peer_snapshot > $O/peers-after.txt
cmp -s $O/peers-before.txt $O/peers-after.txt || { echo "## peers' mounts/processes changed during the run (inspect; files kept)"; [ $rc = 0 ] && rc=4; }
(cd $C && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; [ $rc = 0 ] && rc=4; }
echo "## outputs $O"; echo "## che-r1-extract rc=$rc (NOT a recovery, canonical-state or reset acceptance)"; exit $rc
