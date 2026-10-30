#!/bin/bash
# compact-header-extraction-stage/r3 FIXTURE end-to-end tests (prepared by Claude 1881/1892; NOT run by Claude). Real r9 sessions over the r9
# fixture parent-clean.qcow2 and the r2 metadata fixture meta.qcow2, built fresh in a NEW /vm E2E workspace; never the backup. Unprivileged,
# NOT under unshare (FUSE needs the host fusermount3). Root, MAIN lane 1024 (extract.py checks the lane in every run):
#   bash jobs/q-exit-status.sh che-r3-e2e 1024 bash compact-header-extraction-stage/r3/jobs/e2e-tests.sh
# r2 (review 1885 B1, root 1892): BEFORE any fixture build or mount: the r9 guards, the pinned /vm mount identity, and coordination.py =
# ALL 265 parts committed + verified AND no multipart driver/batch/session/stage mount (no exception, no driver pause); /vm free >= the
# multipart vm reservation + 40 GiB floor + a 2 GiB E2E budget. Root-side writes: only this job's small logs. Expect "## PASS (8)".
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh
guards                                                     # r9: not root, r9 SUMS, pinned fuse2fs/qemu tools, FUSE present
C=$P/compact-header-extraction-stage/r3
(cd $C && sha256sum -c --quiet SHA256SUMS) || die "compact-header-extraction-stage/r3 != SHA256SUMS"
MI=$P/base-state-readonly-stage/r12/jobs/mount_identity.py; MI_SHA=fc4d1ede042e36894a70d1e825a1f934dc0fd16239ce700e39d402ebb79918a1
[ "$(sha256sum < $MI | cut -c1-64)" = $MI_SHA ] || die "mount_identity.py is not the pinned file"
python3 -I -B $MI --target /vm/enclave-volumes --uuid aaae081c-f829-4484-a50f-a9bbb87d31f9 --source /dev/mapper/cryptvm --fstype ext4 \
  --majmin 253:1 || die "/vm is not the pinned device"
O=$C/runs/e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p -m 0700 $C/runs && mkdir -m 0700 $O || die "log dir"
python3 -I -B $C/jobs/coordination.py > $O/coordination.json 2> $O/coordination.err; crc=$?
cat $O/coordination.json $O/coordination.err
[ $crc = 0 ] || die "coordination refused (not all 265 complete, a driver/batch/session active, or a floor): nothing built or mounted"
read -r VMRES VMFLOOR < <(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["vmReserveBytes"], d["vmFloorBytes"])' $O/coordination.json) || die "coordination output"
WP=/vm/enclave-volumes/tr004-base-recovery-20261026
[ "$(df --output=avail -B1 $WP | tail -1)" -ge $((VMRES + VMFLOOR + (2 << 30))) ] || die "/vm free < vm reservation + floor + 2 GiB E2E budget"
W=$WP/compact-header-e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -m 0700 $W $W/work || die "E2E workspace"
peer_snapshot > $O/peers-before.txt
trap ':' TERM INT HUP                                      # r2 (1885 H2): the test children clean up; the evidence below is still taken
env -i PATH=$PATH LC_ALL=C CHE_WORK=$W/work CHE_FUSE2FS=$FUSE2FS CHE_FUSE2FS_SHA256=$FUSE2FS_SHA \
  timeout -k 10 3600 python3 -I -B -u -W always::ResourceWarning $C/tests/test_extract_e2e.py > $O/stdout 2> $O/stderr; rc=$?
peer_snapshot > $O/peers-after.txt
tail -40 $O/stderr
grc=1
[ $rc = 0 ] && grep -q '^Ran 8 tests' $O/stderr && [ "$(grep -v '^$' $O/stderr | tail -1)" = OK ] \
  && ! grep -qE 'ResourceWarning|skipped|Traceback' $O/stderr && grc=0
grep -qF "$W" /proc/self/mountinfo && { echo "## a mount of $W survived (manual cleanup: README)"; grc=1; }
pgrep -u "$(id -u)" -f -- "$W" >/dev/null && { echo "## a process of $W survived (manual cleanup: README)"; grc=1; }
cmp -s $O/peers-before.txt $O/peers-after.txt || { echo "## peers changed"; grc=1; }
(cd $C && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; grc=1; }
du -sb $W > $O/workspace-bytes.txt 2>&1
[ $grc = 0 ] && echo "## PASS (8)" || echo "## FAIL (rc $rc)"
echo "## workspace $W (kept for review; owned; remove after review)"; echo "## outputs $O"; exit $grc
