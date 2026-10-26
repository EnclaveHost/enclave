#!/bin/bash
# base-finality-proof-stage/r10-recovery-fixture-fix: root's LOCAL, OFFLINE single-test job (PREPARED; NOT run by Claude). Runs ONLY
# Recovery.test_bounds_are_derived_never_widened with the fixture-only corrected tests/r7-ported/test_reanchor_recovery.py
# (= r10's + integration/test_reanchor_recovery.patch) over the EXACT frozen r10 harness/wrapper/producer/capture bytes (r10 SHA256SUMS
# 1dbb3abb...), the same recovery-copy layout and env as the r10 job's reanchor-recovery suite. Private work in a 0700 mktemp dir removed on
# ANY exit; logs/ receives only the test output and the verdict line.
#   FX=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-recovery-fixture-fix
#   python3 -u $FX/../../../claude-test-queue.py --mib 1536 --log $FX/logs/root-r10-recovery-fixture-fix.guard -- unshare -rn bash $FX/jobs/root-r10-recovery-fixture-fix.sh
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/r10; R9=$B/r9; RP=$B/runtime-pin; CC=$P/production-capture-closure-stage; RR7=$P/base-reanchor-recovery-stage/r7
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source; HELP=$P/logs/base-live-help-0603/help.txt
FX=$B/r10-recovery-fixture-fix; OUT=$FX/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PW=""; rc=0
die() { echo "## SETUP: $*"; echo "## r10-recovery-fixture-fix rc=9"; exit 9; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
trap '[ -n "$PW" ] && rm -rf --one-file-system -- "$PW"' EXIT
[ ! -e "$OUT" ] && mkdir -p "$OUT" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd $FX && sha256sum -c --quiet SHA256SUMS) || die "fix stage differs from its SHA256SUMS"
pin $ST/SHA256SUMS 1dbb3abb6a8d2e162817d13531b9369b0bceb3eef11d4395f2719b062b4a6dcb
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "frozen r10 changed"
# the r10 job's own fixture-input pins, verbatim
pin $R9/SHA256SUMS ba41aefa62740550b423adaa4f717d45994b9557088a4de7a3206f5db45c5b44; pin $RP/SHA256SUMS 55c5e7b45ecc18f455ed8b1e8dcf48480f8337ab7e8beb574fa5d15573813936; pin $CC/SHA256SUMS 8608830aab2e61618a00ae17d9f2289ac390aaf105e190f561780da0a5725172; pin $RR7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb; pin $A2/a2a4.py abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd; pin $HELP d393bab10e34092808652c18356a14495f236474efc2408f346afd4886f38025
pin $FAKE 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802
for d in $R9 $RP $CC; do (cd $d && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
(cd $RR7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
PW=$(mktemp -d /tmp/r10recfix.XXXXXXXX) && chmod 0700 $PW || die "private dir"
cp $ST/tests/r7-ported/test_reanchor_recovery.py $PW/t.py && (cd $PW && patch -s t.py < $FX/integration/test_reanchor_recovery.patch) \
  && cmp -s $PW/t.py $FX/tests/r7-ported/test_reanchor_recovery.py || die "test != r10 + patch"
WK=$PW/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $ST/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
SC=$PW/stage; tcopy $ST $SC; (cd $SC && sha256sum -c --quiet SHA256SUMS) || die "private r10 copy"; CAPM=$SC/capture/a1_capture.py
C=$PW/recovery; tcopy $RR7 $C
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/*.py $ST/tests/test_r62_followups.py $ST/tests/forward-sync/test_forward_sync.py $C/tests/ || die "recovery copy swap"
cp $FX/tests/r7-ported/test_reanchor_recovery.py $C/tests/test_reanchor_recovery.py || die "test swap"
for f in harness/a2a4.py wrapper/chain_service.py producer/base_launch.py; do cmp -s $ST/$f $C/$f || die "$f is not r10's"; done
mkdir -m 0700 $PW/tmp || die tmp
RE=(env TMPDIR=$PW/tmp PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
(cd $C && "${RE[@]}" timeout 1800 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py -v Recovery.test_bounds_are_derived_never_widened < /dev/null) > $OUT/reanchor-bounds.txt 2>&1; r=$?
f=$OUT/reanchor-bounds.txt; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
if [ $r = 0 ] && [ "$last" = OK ] && [ "$ran" = 1 ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS reanchor-bounds Ran $ran (expected 1)"
else echo "## FAIL: reanchor-bounds: rc $r, Ran ${ran:-?} (expected 1), last ${last:-none} (see $f)"; rc=1; fi
echo "## r10-recovery-fixture-fix rc=$rc"; exit $rc
