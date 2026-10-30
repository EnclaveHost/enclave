#!/bin/bash
# base-finality-proof-stage/r5: root's LOCAL, OFFLINE job (PREPARED; NOT run by Claude). Foreground, through the existing queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r5
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 768 --log $ST/logs/root-finality-r5-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r5-tests.sh > $ST/logs/root-finality-r5-tests.out 2>&1; echo $? > $ST/logs/root-finality-r5-tests.rc
# EXECUTES (exact counts, no skip, rc 0 each): tool 30, real-tool integration 11, readiness sampler 91 (89 + 2 gate tests), and in a
# PRIVATE COPY of recovery r7 with the r5 harness, wrapper, producer and ported suite: reanchor-recovery 24 (19 + 5 FinalityRestart),
# r3-regression 27, recovery-existing wrapper suite 34. REUSES (byte-identity checked, else exit 2): JS core 20 (r2 root 0234);
# baseline-existing 34 (the production base wrapper is not changed by this stage; r6 0336 via r7 0345).
# Prints '## r5 SHA256SUMS <sha>' and '## finality-r5 rc=<rc>': install/install_verified.py requires both from a passing run.
# Exit: 0 pass | 1 fail | 2 reuse invalid | 9 setup.
set -uo pipefail
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/base-finality-proof-stage/r5; R4=$P/base-finality-proof-stage/r4; R2=$P/base-finality-proof-stage/r2; R7=$P/base-reanchor-recovery-stage/r7
PR=$P/pruned-readiness-stage/patched; DEPS=$P/source; CAP=$P/a1-capture-binding-stage/r4/src/a1_capture.py
OUT=$ST/logs/root-finality-r5-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## finality-r5 rc=9"; exit 9; }
reuse() { echo "## REUSE INVALID: $*"; echo "## finality-r5 rc=2"; exit 2; }
fail() { echo "## FAIL: $*"; rc=1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "r5 files differ from SHA256SUMS"
for d in $R4 $R2; do (cd "$d" && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
(cd "$R7" && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
[ "$(sha256sum < $CAP | cut -c1-64)" = db81ea49a2c241ee16ea0018e11dcedccadeb8bb678f51e68394470185639d20 ] || die "capture r4 module is not db81ea49"
[ "$(sha256sum < $PR/readiness_sampler.py | cut -c1-64)" = 9aa80ab8a2cbe156f513349f44366c4ad2c8588539666ac802ed9015c771d055 ] || die "sampler base differs"
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
python3 -I -c 'import json,sys; sys.exit(json.load(open(sys.argv[1]))["version"]!="1.8.0")' "$DEPS/node_modules/@noble/hashes/package.json" || die "@noble/hashes is not 1.8.0"
T=$OUT/tmp/patchcheck
for x in harness/a2a4.py:harness-r7-to-r5:$R7 src/finality_state.py:finality_state-r4-to-r5:$R4 wrapper/chain_service.py:wrapper-r4-to-r5:$R4 \
         producer/base_launch.py:producer-r4-to-r5:$R4 tests/test_finality_state.py:tool-tests-r4-to-r5:$R4 \
         tests/test_finality_integration.py:integration-tests-r4-to-r5:$R4; do IFS=: read -r f p base <<< "$x"
  rm -rf $T; mkdir -p $T/$(dirname $f) && cp $base/$f $T/$f && (cd $T && patch -s -p1 < $ST/integration/$p.patch) && cmp -s $T/$f $ST/$f || die "$f != base + $p.patch"; done
for x in readiness_sampler.py:readiness/readiness_sampler.py:sampler-pruned-to-r5:$PR test_readiness_sampler.py:readiness/test_readiness_sampler.py:sampler-tests-pruned-to-r5:$PR \
         tests/test_reanchor_recovery.py:tests/r7-ported/test_reanchor_recovery.py:r7-recovery-tests-r7-to-r5:$R7; do IFS=: read -r bf f p base <<< "$x"
  rm -rf $T; mkdir -p $T && cp $base/$bf $T/x && (cd $T && patch -s x < $ST/integration/$p.patch) && cmp -s $T/x $ST/$f || die "$f != base + $p.patch"; done
for x in src/finality-core.mjs vendor a1gate tests/finality-core.test.mjs tests/helpers; do diff -r -q "$R2/$x" "$ST/$x" > /dev/null || reuse "$x differs from r2"; done
cmp -s $R7/harness/selection.py $ST/harness/selection.py || die "harness selection.py differs from r7"
[ "$(cat $P/logs/root-finality-prototype-r2-0234.rc)" = 0 ] || reuse "root r2 0234 is not rc 0"
L=$R2/logs/root-finality-tests-20261026T023106Z-598302
for kv in "tests 20" "pass 20" "fail 0" "skipped 0"; do grep -qx "# $kv" $L/js.tap || reuse "r2 JS log lacks '# $kv'"; done
grep -q 'REUSED (exact r6 evidence' $P/logs/root-reanchor-r7-0345.out && [ "$(cat $P/logs/root-reanchor-r7-0345.rc)" = 0 ] || reuse "root r7 0345 is not PASS"
grep -qx 'FINALITY_PROOF_REVIEWED = False' $ST/producer/base_launch.py || fail "producer FINALITY_PROOF_REVIEWED is not False"
grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' $ST/src/finality_state.py || fail "FINALITY_PROTOTYPE_REVIEWED is not False"
grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' $ST/wrapper/chain_service.py || fail "wrapper LAUNCH_PRODUCER_REVIEWED is not False"
grep -qx 'A1_CAPTURE_REVIEWED = False' $ST/harness/a2a4.py || fail "harness A1_CAPTURE_REVIEWED is not False"
H=$(sha256sum < $ST/harness/a2a4.py | cut -c1-64); F=$(sha256sum < $ST/src/finality_state.py | cut -c1-64)
grep -q "HARNESS_SHA256 = '$H'" $ST/src/finality_state.py && grep -q "RECOVERY_A2A4_SHA256 = '$H'" $ST/producer/base_launch.py \
  && grep -q "FINALITY_STATE_SHA256 = '$F'" $ST/producer/base_launch.py || fail "byte pins are not consistent (harness $H, tool $F)"
python3 -I - $ST <<'PY' || fail "install manifest does not name the stage's exact bytes"
import hashlib, json, pathlib, sys
S = pathlib.Path(sys.argv[1]); m = json.loads((S / 'install/MANIFEST.json').read_bytes())
for e in m['files']:
    p = pathlib.Path(e['src']) if e['src'].startswith('/') else S / e['src']
    assert hashlib.sha256(p.read_bytes()).hexdigest() == e['sha256'], e['src']
PY
ENVV=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$ST/harness/a2a4.py PRODUCER_WORK=$P)
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests?' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
(cd $ST && "${ENVV[@]}" timeout 1200 python3 -I -B tests/test_finality_state.py -v < /dev/null) > $OUT/tool.txt 2>&1; check tool 30 $?
(cd $ST && "${ENVV[@]}" timeout 2400 python3 -I -B tests/test_finality_integration.py -v < /dev/null) > $OUT/integration.txt 2>&1; check integration 11 $?
(cd $ST/readiness && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 1200 python3 -I -B test_readiness_sampler.py < /dev/null) > $OUT/sampler.txt 2>&1; check sampler 91 $?
C=$OUT/r7-with-r5; cp -a $R7 $C && rm -rf $C/logs/* && find $C -name __pycache__ -prune -exec rm -rf {} + || die "r7 copy"
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/test_reanchor_recovery.py $C/tests/ || die "r7 copy swap"
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 python3 -E -s -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 24 $?
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 python3 -E -s -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 27 $?
(cd $C/wrapper && env TMPDIR=$OUT/tmp timeout 600 python3 -E -s -m unittest -v test_chain_service < /dev/null) > $OUT/recovery-existing.txt 2>&1; check recovery-existing 34 $?
echo "REUSED: JS core 20 (r2 0234, byte-identical); baseline-existing 34 (production wrapper unchanged; r6 0336 via r7 0345)"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r5 files CHANGED during the run"
(cd "$R7" && sha256sum -c --quiet MANIFEST.sha256) || fail "r7 CHANGED during the run"
echo "## outputs: $OUT"; echo "## r5 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r5 rc=$rc"; exit $rc
