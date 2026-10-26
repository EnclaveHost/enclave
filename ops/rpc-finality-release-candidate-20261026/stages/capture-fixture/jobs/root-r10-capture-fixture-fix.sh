#!/bin/bash
# base-finality-proof-stage/r10-capture-fixture-fix: root's LOCAL, OFFLINE job (PREPARED; NOT run by Claude). Runs ONLY capture-r10 (exact 3)
# with the fixture-only corrected tests/test_capture_r10.py (= r10's + integration/test_capture_r10.patch) against the EXACT frozen r10
# bytes (capture module 47c49b11..., harness, integration fixture; every other r10 file checked against r10 SHA256SUMS 1dbb3abb...).
# Private fixture work lives in a 0700 mktemp dir removed on ANY exit; logs/ receives only the test output and the verdict line.
#   FX=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-capture-fixture-fix
#   python3 -u $FX/../../../claude-test-queue.py --mib 1536 --log $FX/logs/root-r10-capture-fixture-fix.guard -- unshare -rn bash $FX/jobs/root-r10-capture-fixture-fix.sh
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/r10; R9=$B/r9; RP=$B/runtime-pin; CC=$P/production-capture-closure-stage; RR7=$P/base-reanchor-recovery-stage/r7
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source; HELP=$P/logs/base-live-help-0603/help.txt
FX=$B/r10-capture-fixture-fix; OUT=$FX/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PW=""; rc=0
die() { echo "## SETUP: $*"; echo "## r10-capture-fixture-fix rc=9"; exit 9; }
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
PW=$(mktemp -d /tmp/r10capfix.XXXXXXXX) && chmod 0700 $PW || die "private dir"
# the corrected test is exactly r10's test + this stage's (fixture-only) patch
cp $ST/tests/test_capture_r10.py $PW/t.py && (cd $PW && patch -s t.py < $FX/integration/test_capture_r10.patch) && cmp -s $PW/t.py $FX/tests/test_capture_r10.py || die "test != r10 + patch"
WK=$PW/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $ST/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
SC=$PW/stage; tcopy $ST $SC; cp $FX/tests/test_capture_r10.py $SC/tests/test_capture_r10.py || die "test swap"
(cd $SC && grep -v '  \./tests/test_capture_r10\.py$' SHA256SUMS | sha256sum -c --quiet) || die "private r10 copy differs beyond the one test"
CAPM=$SC/capture/a1_capture.py; pin $CAPM 47c49b114e6d596a7dd3c46a9f4a5e55bb016cd140a95e001a58ff9a0e69c5b5
mkdir -m 0700 $PW/tmp || die tmp
E=(env -i PATH=/usr/bin:/bin TMPDIR=$PW/tmp HOME=$PW/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
(cd $SC && "${E[@]}" timeout 1800 /usr/bin/python3 -I -B tests/test_capture_r10.py -v < /dev/null) > $OUT/capture-r10.txt 2>&1; r=$?
f=$OUT/capture-r10.txt; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
if [ $r = 0 ] && [ "$last" = OK ] && [ "$ran" = 3 ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS capture-r10 Ran $ran (expected 3)"
else echo "## FAIL: capture-r10: rc $r, Ran ${ran:-?} (expected 3), last ${last:-none} (see $f)"; rc=1; fi
echo "## r10-capture-fixture-fix rc=$rc"; exit $rc
