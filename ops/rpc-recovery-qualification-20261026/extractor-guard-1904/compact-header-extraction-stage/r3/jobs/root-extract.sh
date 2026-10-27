#!/bin/bash
# compact-header-extraction-stage/r3 PRODUCTION extraction (prepared by Claude 1881/1892; NOT run by Claude). MAIN LANE, coordinated, never automatic;
# NOT under unshare (FUSE). Only after unit + e2e PASS, review, and a root-written request:
#   python3 -I -B compact-header-extraction-stage/r3/extract.py request --stage-sums "$(sha256sum < compact-header-extraction-stage/r3/SHA256SUMS | cut -c1-64)" > REQ
#   (review REQ, keep it read-only)  bash jobs/q-exit-status.sh che-r3-extract 1024 bash compact-header-extraction-stage/r3/jobs/root-extract.sh REQ "$(sha256sum < REQ | cut -c1-64)"
# Output: a NEW /vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-<ts>-<pid>/ (files/, EXTRACTION-RECEIPT.json,
# session/receipt.json). rc 0 CLEAN; 3 refused; 4 failed (kept); 5 stopped (graceful stop: kill -TERM the extract.py pid, never the queue).
set -uo pipefail
[ $# = 2 ] || { echo "usage: root-extract.sh REQUEST REQUEST_SHA256"; exit 9; }
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh
guards                                                     # r9: not root, r9 SUMS, pinned fuse2fs/qemu tools, FUSE present
# r2: the pinned /vm mount identity (bsro r7/r12 mount_identity.py: uuid/source/fstype/majmin) BEFORE anything else
MI=$P/base-state-readonly-stage/r12/jobs/mount_identity.py; MI_SHA=fc4d1ede042e36894a70d1e825a1f934dc0fd16239ce700e39d402ebb79918a1
[ "$(sha256sum < $MI | cut -c1-64)" = $MI_SHA ] || die "mount_identity.py is not the pinned file"
python3 -I -B $MI --target /vm/enclave-volumes --uuid aaae081c-f829-4484-a50f-a9bbb87d31f9 --source /dev/mapper/cryptvm --fstype ext4 \
  --majmin 253:1 || die "/vm is not the pinned device"
C=$P/compact-header-extraction-stage/r3
(cd $C && sha256sum -c --quiet SHA256SUMS) || die "compact-header-extraction-stage/r3 != SHA256SUMS"
SUMS=$(sha256sum < $C/SHA256SUMS | cut -c1-64)
[ -f "$1" ] && [ ! -L "$1" ] && [ ! -w "$1" ] || die "the request must be a read-only regular file"
O=$C/runs/extract-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p -m 0700 $C/runs && mkdir -m 0700 $O || die "run dir"
peer_snapshot > $O/peers-before.txt
python3 -I -B $C/jobs/coordination.py > $O/coordination.json 2> $O/coordination.err; crc=$?
cat $O/coordination.json $O/coordination.err
[ $crc = 0 ] || die "coordination refused (not all 265 complete, a driver/batch/session active, or a floor): see $O/coordination.json"
read -r VMRES VMFLOOR < <(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["vmReserveBytes"], d["vmFloorBytes"])' $O/coordination.json) || die "coordination output"
trap ':' TERM INT HUP                                      # r2 (1885 H2): extract.py stops gracefully; the evidence below is still taken
python3 -I -B $C/extract.py run --dest-parent /vm/enclave-volumes/tr004-base-recovery-20261026 --request "$1" --request-sha256 "$2" \
  --stage-sums $SUMS --reserve-bytes $VMRES --floor-bytes $VMFLOOR > $O/extract.out 2> $O/extract.err; rc=$?; xrc=$rc
cat $O/extract.out; tail -20 $O/extract.err
peer_snapshot > $O/peers-after.txt
cmp -s $O/peers-before.txt $O/peers-after.txt || { echo "## peers' mounts/processes changed during the run (inspect; files kept)"; [ $rc = 0 ] && rc=4; }
sc=0; (cd $C && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; sc=1; [ $rc = 0 ] && rc=4; }
# r3 (review 1894 X1): the LAST step publishes $O/JOB-RECEIPT.json atomically (final rc, extract rc, SUMS before/after + check, peer
# snapshot shas/equality, the exact EXTRACTION-RECEIPT.json path + sha). The state runner requires it: an inner CLEAN alone never suffices.
python3 -I -B $C/extract.py job-receipt --job-dir $O --extract-rc $xrc --final-rc $rc --stage-sums-before $SUMS \
  --stage-check-after $sc; rc=$?
echo "## outputs $O"; echo "## che-r3-extract rc=$rc (NOT a recovery, canonical-state or reset acceptance)"; exit $rc
