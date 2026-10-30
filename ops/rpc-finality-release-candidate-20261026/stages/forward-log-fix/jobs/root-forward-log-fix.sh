#!/bin/bash
# base-finality-proof-stage/r10-forward-repair: root's LOCAL, OFFLINE run of the repaired forward-sync suite, full 8, against the EXACT
# frozen r10 modules (forward_sync, harness, wrapper, producer, ported recovery fixture). PREPARED; NOT run by Claude. Queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-forward-repair
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1536 --log $ST/logs/root-r10-forward-repair-tests.guard -- unshare -rn bash $ST/jobs/root-r10-forward-repair-tests.sh > $ST/logs/root-r10-forward-repair-tests.out 2>&1; echo $? > $ST/logs/root-r10-forward-repair-tests.rc
# The ONLY change is tests/forward-sync/test_forward_sync.py (= r10's + patches/, checked). Product change: random suffix prevents same-second retry log collisions; exclusive creation remains enforced.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; R10=$B/r10; ST=$B/r10-forward-log-fix; RR7=$P/base-reanchor-recovery-stage/r7
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py
OUT=$ST/logs/root-r10-forward-repair-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## r10-forward-repair rc=9"; exit 9; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
pin $R10/SHA256SUMS 1dbb3abb6a8d2e162817d13531b9369b0bceb3eef11d4395f2719b062b4a6dcb; (cd $R10 && sha256sum -c --quiet SHA256SUMS) || die "r10 changed"
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "repair files differ from SHA256SUMS"
pin $A2/a2a4.py abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd; pin $RR7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb; pin $FAKE 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802
(cd $RR7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
cp $R10/recovery/forward_sync.py $OUT/tmp/forward.py && (cd $OUT/tmp && patch -s forward.py < $ST/patches/forward-sync-log-uniqueness.patch) && cmp -s $OUT/tmp/forward.py $ST/src/forward_sync.py || die 'forward module != r10 + reviewed log patch'
f=tests/forward-sync/test_forward_sync.py; T=$OUT/tmp/pc; mkdir -p $T && cp $R10/$f $T/x && (cd $T && patch -s x < $ST/patches/tests_forward-sync_test_forward_sync.py.patch) && cmp -s $T/x $ST/$f || die "$f != r10 + patch"
WK=$OUT/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $R10/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
C=$OUT/recovery; tcopy $RR7 $C
cp $R10/harness/a2a4.py $C/harness/ && cp $R10/wrapper/chain_service.py $C/wrapper/ && cp $R10/producer/base_launch.py $C/producer/ \
  && cp $R10/tests/r7-ported/*.py $R10/tests/test_r62_followups.py $C/tests/ && cp $ST/$f $C/tests/test_forward_sync.py || die "recovery copy swap"
(cd $C && env TMPDIR=$OUT/tmp PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK CAPTURE_MODULE=$R10/capture/a1_capture.py FORWARD_SYNC_SRC=$ST/src \
   timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_forward_sync.py < /dev/null) > $OUT/forward-sync.txt 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+ tests? in ' $OUT/forward-sync.txt | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $OUT/forward-sync.txt | tail -1)
if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = 8 ] && ! grep -qE 'skipped|expected failure|unexpected success' $OUT/forward-sync.txt; then echo "PASS forward-sync Ran 8 (expected 8)"
else echo "## FAIL: forward-sync: rc $r, Ran ${ran:-?} (expected 8), last ${last:-none} (see $OUT/forward-sync.txt)"; rc=1; fi
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## FAIL: repair files CHANGED during the run"; rc=1; }
echo "## outputs: $OUT"; echo "## r10-forward-repair SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## r10-forward-repair rc=$rc"; exit $rc
