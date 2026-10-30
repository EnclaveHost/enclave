#!/bin/bash
# base-finality-proof-stage/runtime-pin (PREPARED; NOT run by Claude). Queue guidance: ~2 GiB peak is not expected; 1024 MiB like r9.
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/runtime-pin
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1024 --log $ST/logs/root-runtime-pin-tests.guard -- unshare -rn bash $ST/jobs/root-runtime-pin-tests.sh > $ST/logs/root-runtime-pin-tests.out 2>&1; echo $? > $ST/logs/root-runtime-pin-tests.rc
# Runs ONLY what finality_state's runtime-pin change touches, in private copies of frozen r9 (r9 untouched), exact 'Ran N tests in' + bare
# OK, no skip, rc 0: runtime-pin 10, tool 34, integration 17 (the real core run now checks its own sharedObjects), reproof 9 (drives qualify).
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/runtime-pin; R9=$B/r9; CC=$P/production-capture-closure-stage; RR7=$P/base-reanchor-recovery-stage/r7
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source
OUT=$ST/logs/root-runtime-pin-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## runtime-pin rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
[ "$(sha256sum < $R9/SHA256SUMS | cut -c1-64)" = ba41aefa62740550b423adaa4f717d45994b9557088a4de7a3206f5db45c5b44 ] && (cd $R9 && sha256sum -c --quiet SHA256SUMS) || die "r9 changed"
[ "$(sha256sum < $CC/SHA256SUMS | cut -c1-64)" = 8608830aab2e61618a00ae17d9f2289ac390aaf105e190f561780da0a5725172 ] && (cd $CC && sha256sum -c --quiet SHA256SUMS) || die "capture closure changed"
[ "$(sha256sum < $FAKE | cut -c1-64)" = 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802 ] || die "pinned fake changed"
T=$OUT/tmp/pc
for x in src/finality_state.py:finality_state-runtime-pin tests/test_finality_state.py:test_finality_state-runtime-pin; do IFS=: read -r f p <<< "$x"
  rm -rf $T; mkdir -p $T && cp $R9/$f $T/x && (cd $T && patch -s x < $ST/patches/$p.patch) && cmp -s $T/x $ST/$f || die "$f != r9 + $p"; done
grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' $ST/src/finality_state.py || die "flag"
WK=$OUT/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $R9/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; mkdir -p $WK/production-capture-closure-stage/src && cp $CC/src/a1_capture.py $WK/production-capture-closure-stage/src/ || die "closure"
tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
SC=$OUT/stage; tcopy $R9 $SC; cp $ST/src/finality_state.py $SC/src/ && cp $ST/tests/test_finality_state.py $ST/tests/test_runtime_pin.py $SC/tests/ || die "swap"
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
E=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$WK CAPTURE_MODULE=$SC/capture/a1_capture.py)
for s in runtime-pin:test_runtime_pin.py:10:600 tool:test_finality_state.py:34:1200 integration:test_finality_integration.py:17:3000 reproof:test_reproof.py:9:3600; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
echo "## outputs: $OUT"; echo "## runtime-pin SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## runtime-pin rc=$rc"; exit $rc
