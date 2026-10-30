#!/bin/bash
# production-bootstrap-wiring-stage: ONE bounded offline root job (PREPARED; NOT run by Claude). Composes r12-final + this overlay in a
# private copy (every overlay file must equal r12-final + its patches/*.patch, or be new), then runs every suite whose code changed.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh bootstrap-wiring-1 768 unshare -rn bash production-bootstrap-wiring-stage/r2/jobs/root-bootstrap-wiring.sh
# EXPECTED: bootstrap-wiring 22, r3-regression 28, reanchor-recovery 25, r62-isolated 2, forward-sync 8 (recovery-copy layout);
#           ops-installer 18, forward-sync-r2 6, integration 17, reproof 17 (composed stage copy). No skips.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; ST=$P/production-bootstrap-wiring-stage/r2; R12=$P/base-finality-proof-stage/r12-final
RR7=$P/base-reanchor-recovery-stage/r7; A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
FAKE=$P/base-finality-proof-stage/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source; HELP=$P/logs/base-live-help-0603/help.txt
OUT=$ST/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## bootstrap-wiring-r2 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
[ "$(sha256sum < $R12/SHA256SUMS | cut -c1-64)" = 9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e ] && (cd $R12 && sha256sum -c --quiet SHA256SUMS) || die "r12-final changed"
# ---- composition check: overlay = r12-final + patch (edited files) -------------------------------------------------------------
for f in harness-first/a2a4.py producer/base_launch.py src/reproof.py units/enclave-base-finality-reproof.service install/install_verified.py tests/r7-ported/test_r3_launcher.py; do
  T=$OUT/tmp/pc; rm -rf $T; mkdir -p $T && cp $R12/$f $T/x && (cd $T && patch -s x < $ST/patches/$(echo $f | tr / _).patch) && cmp -s $T/x $ST/overlay/$f || die "$f != r12-final + its patch"; done
/usr/bin/python3 -I - $ST/overlay <<'PYP' || die "pin cascade"
import hashlib, pathlib, sys
O = pathlib.Path(sys.argv[1]); h = lambda p: hashlib.sha256((O / p).read_bytes()).hexdigest(); t = lambda p: (O / p).read_text()
assert f"A2A4_SOURCE_SHA256 = '{h('harness-first/a2a4.py')}'" in t('producer/base_launch.py')
assert f"'{h('harness-first/a2a4.py')}')" in t('bootstrap/a1_capture_original.py')
assert f"'{h('producer/base_launch.py')}')" in t('src/reproof.py')
for f, line in (('harness-first/a2a4.py', 'A1_LEGACY_TEST_ONLY = False'), ('harness-first/a2a4.py', 'A1_FIRST_CAPTURE_REVIEWED = False'), ('producer/base_launch.py', 'A1_LEGACY_TEST_ONLY = False')):
    assert any(l.startswith(line) for l in t(f).splitlines()), (f, line)
print('pin cascade OK')
PYP
# ---- layouts ------------------------------------------------------------------------------------------------------------------
WK=$OUT/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $ST/overlay/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
SC=$OUT/stage; tcopy $R12 $SC; (cd $ST/overlay && tar -cf - harness-first producer src units install) | (cd $SC && tar -xf -) || die "compose"; CAPM=$SC/capture/a1_capture.py
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
E=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
for s in ops-installer:test_ops_installer.py:18:600 integration:test_finality_integration.py:17:1800 reproof:test_reproof.py:17:1800; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FORWARD_SYNC_SRC=$SC/recovery R2_PRODUCER=$SC/producer/base_launch.py BASE_HELP=$HELP \
   timeout 600 /usr/bin/python3 -I -B tests/forward-sync/test_forward_sync_r2.py -v < /dev/null) > $OUT/forward-sync-r2.txt 2>&1; check forward-sync-r2 6 $?
C=$OUT/recovery; tcopy $RR7 $C
cp $R12/harness/a2a4.py $C/harness/ && cp $R12/wrapper/chain_service.py $C/wrapper/ && cp $ST/overlay/producer/base_launch.py $C/producer/ \
  && cp $R12/tests/r7-ported/*.py $R12/tests/test_r62_followups.py $R12/tests/forward-sync/test_forward_sync.py $C/tests/ \
  && cp $ST/overlay/tests/r7-ported/test_r3_launcher.py $ST/overlay/tests/r7-ported/test_bootstrap_wiring.py $C/tests/ || die "recovery copy swap"
RE=(env TMPDIR=$OUT/tmp PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM FINALITY_NODE=$NODE WIRING_OVERLAY=$ST/overlay R12_UNITS=$R12/units)
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_bootstrap_wiring.py < /dev/null) > $OUT/bootstrap-wiring.txt 2>&1; check bootstrap-wiring 22 $?
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 28 $?
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 25 $?
(cd $C && "${RE[@]}" FINALITY_SRC=$R12/src timeout 600 /usr/bin/python3 -E -s -B -u tests/test_r62_followups.py < /dev/null) > $OUT/r62-isolated.txt 2>&1; check r62-isolated 2 $?
(cd $C && "${RE[@]}" FORWARD_SYNC_SRC=$R12/recovery timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_forward_sync.py < /dev/null) > $OUT/forward-sync.txt 2>&1; check forward-sync 8 $?
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
echo "## outputs: $OUT"; echo "## bootstrap-wiring-r2 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## bootstrap-wiring-r2 rc=$rc"; exit $rc
