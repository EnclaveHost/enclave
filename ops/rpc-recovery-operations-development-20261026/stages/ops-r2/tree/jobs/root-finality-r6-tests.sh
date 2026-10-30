#!/bin/bash
# base-finality-proof-stage/r6: root's LOCAL, OFFLINE job (PREPARED; NOT run by Claude). Foreground, through the existing queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r6
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r6-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r6-tests.sh > $ST/logs/root-finality-r6-tests.out 2>&1; echo $? > $ST/logs/root-finality-r6-tests.rc
# EXECUTES (exact counts, no skip, rc 0): tool 34, real-tool integration 16, sampler 92, and in a PRIVATE COPY of recovery r7 with the
# r6 harness/wrapper/producer and the ported suites: reanchor-recovery 24, r3-regression 27, recovery-existing 34. REUSES (pinned by
# sha below, else exit 2): JS core 20 (r2 0234 js.tap), baseline-existing 34 (r7 0345 out). Prints '## r6 SHA256SUMS' + '## finality-r6 rc='.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/base-finality-proof-stage/r6; R5=$P/base-finality-proof-stage/r5; R2=$P/base-finality-proof-stage/r2; R7=$P/base-reanchor-recovery-stage/r7
PR=$P/pruned-readiness-stage/patched; DEPS=$P/source; CAP=$P/a1-capture-binding-stage/r4/src/a1_capture.py
OUT=$ST/logs/root-finality-r6-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## finality-r6 rc=9"; exit 9; }
reuse() { echo "## REUSE INVALID: $*"; echo "## finality-r6 rc=2"; exit 2; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "r6 files differ from SHA256SUMS"
pin $R2/SHA256SUMS 5f14e2c02656a0bb14128e623e96f751f427893429fe3874648a3f5c70a7b5e0; pin $R5/SHA256SUMS 81e3050bc00176d8ebeda682e2532cd7300e4038768fe9f142b65ede101a6b3b; pin $R7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb
for d in $R2 $R5; do (cd "$d" && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
(cd "$R7" && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
pin $CAP db81ea49a2c241ee16ea0018e11dcedccadeb8bb678f51e68394470185639d20; pin $PR/readiness_sampler.py 9aa80ab8a2cbe156f513349f44366c4ad2c8588539666ac802ed9015c771d055
pin $P/coverage-stage/origin_extract.py 6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
/usr/bin/python3 -I -c 'import json,sys; sys.exit(json.load(open(sys.argv[1]))["version"]!="1.8.0")' "$DEPS/node_modules/@noble/hashes/package.json" || die "@noble/hashes is not 1.8.0"
T=$OUT/tmp/patchcheck
chk() { rm -rf $T; mkdir -p $T && cp "$1" $T/x && (cd $T && patch -s x < "$ST/integration/$3.patch") && cmp -s $T/x "$ST/$2" || die "$2 != base + $3.patch"; }
chk $R7/harness/a2a4.py harness/a2a4.py harness-r7-to-r6
for f in src/finality_state.py wrapper/chain_service.py producer/base_launch.py tests/test_finality_state.py tests/test_finality_integration.py install/install_verified.py readiness/readiness_sampler.py readiness/test_readiness_sampler.py; do chk $R5/$f $f "$(echo $f | tr / _)-r5-to-r6"; done
chk $R7/tests/test_reanchor_recovery.py tests/r7-ported/test_reanchor_recovery.py r7-recovery-tests-r7-to-r6
chk $R7/tests/test_r3_launcher.py tests/r7-ported/test_r3_launcher.py r7-r3-launcher-r7-to-r6
for x in src/finality-core.mjs vendor a1gate tests/finality-core.test.mjs tests/helpers; do diff -r -q "$R2/$x" "$ST/$x" > /dev/null || reuse "$x differs from r2"; done
cmp -s $R7/harness/selection.py $ST/harness/selection.py || die "selection.py differs from r7"
pin $R2/logs/root-finality-tests-20261026T023106Z-598302/js.tap 8f629b2091f2e9da5b77f2b8ec65d7bf8d5276889a34eead66f374cc8871ab5c || reuse "r2 JS log changed"
pin $P/logs/root-reanchor-r7-0345.out 8e8fd50453baac3cd72cc161280918f336a123bdeb8a05e89f3808cc0b4a6735 || reuse "r7 0345 log changed"
grep -qx 'FINALITY_PROOF_REVIEWED = False' $ST/producer/base_launch.py || fail "producer FINALITY_PROOF_REVIEWED is not False"
grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' $ST/src/finality_state.py || fail "FINALITY_PROTOTYPE_REVIEWED is not False"
grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' $ST/wrapper/chain_service.py || fail "wrapper LAUNCH_PRODUCER_REVIEWED is not False"
grep -qx 'A1_CAPTURE_REVIEWED = False' $ST/harness/a2a4.py || fail "harness A1_CAPTURE_REVIEWED is not False"
H=$(sha256sum < $ST/harness/a2a4.py | cut -c1-64); F=$(sha256sum < $ST/src/finality_state.py | cut -c1-64); Wr=$(sha256sum < $ST/wrapper/chain_service.py | cut -c1-64)
grep -q "HARNESS_SHA256 = '$H'" $ST/src/finality_state.py && grep -q "RECOVERY_A2A4_SHA256 = '$H'" $ST/producer/base_launch.py && grep -q "FINALITY_STATE_SHA256 = '$F'" $ST/producer/base_launch.py \
  && grep -q "WRAPPER_SHA256 = '$Wr'" $ST/src/finality_state.py && grep -q "WRAPPER_SHA256 = '$Wr'" $ST/producer/base_launch.py || fail "byte pins are not consistent"
/usr/bin/python3 -I - $ST <<'PYM' || fail "install manifest does not name the stage's exact bytes"
import hashlib, json, pathlib, sys
S = pathlib.Path(sys.argv[1]); m = json.loads((S / 'install/MANIFEST.json').read_bytes())
for e in m['files']:
    p = pathlib.Path(e['src']) if e['src'].startswith('/') else S / e['src']
    assert hashlib.sha256(p.read_bytes()).hexdigest() == e['sha256'], e['src']
PYM
ENVV=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$ST/harness/a2a4.py PRODUCER_WORK=$P)
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests?' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
(cd $ST && "${ENVV[@]}" timeout 1200 /usr/bin/python3 -I -B tests/test_finality_state.py -v < /dev/null) > $OUT/tool.txt 2>&1; check tool 34 $?
(cd $ST && "${ENVV[@]}" timeout 3000 /usr/bin/python3 -I -B tests/test_finality_integration.py -v < /dev/null) > $OUT/integration.txt 2>&1; check integration 16 $?
SR=$OUT/sampler; mkdir -p $SR/readiness $SR/coverage && cp $ST/readiness/*.py $SR/readiness/ && cp $P/coverage-stage/origin_extract.py $SR/coverage/ || die "sampler layout"
(cd $SR/readiness && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 1200 /usr/bin/python3 -I -B test_readiness_sampler.py < /dev/null) > $OUT/sampler.txt 2>&1; check sampler 92 $?
C=$OUT/r7-with-r6; cp -a $R7 $C && rm -rf $C/logs/* && find $C -name __pycache__ -prune -exec rm -rf {} + || die "r7 copy"
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/test_reanchor_recovery.py $ST/tests/r7-ported/test_r3_launcher.py $C/tests/ || die "r7 copy swap"
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 24 $?
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 27 $?
(cd $C/wrapper && env TMPDIR=$OUT/tmp timeout 600 /usr/bin/python3 -E -s -B -m unittest -v test_chain_service < /dev/null) > $OUT/recovery-existing.txt 2>&1; check recovery-existing 34 $?
echo "REUSED: JS core 20 (r2 0234 js.tap 8f629b2091f2e9da5b77f2b8ec65d7bf8d5276889a34eead66f374cc8871ab5c); baseline-existing 34 (r7 0345 8e8fd50453baac3cd72cc161280918f336a123bdeb8a05e89f3808cc0b4a6735)"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r6 files CHANGED during the run"
(cd "$R7" && sha256sum -c --quiet MANIFEST.sha256) || fail "r7 CHANGED during the run"
echo "## outputs: $OUT"; echo "## r6 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r6 rc=$rc"; exit $rc
