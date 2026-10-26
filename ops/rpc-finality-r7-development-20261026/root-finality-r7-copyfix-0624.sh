#!/bin/bash
# base-finality-proof-stage/r7 composition: root's LOCAL, OFFLINE qualification job (PREPARED; NOT run by Claude). Through the queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r7
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r7-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r7-tests.sh > $ST/logs/root-finality-r7-tests.out 2>&1; echo $? > $ST/logs/root-finality-r7-tests.rc
# Every suite reports PASS only with its exact count, rc 0, final OK and no skip; anything else is printed as FAIL with its log (never relabeled).
# Stage copy: tool 34, integration 17, reproof 5, ops-readiness 27, ops-installer 13, sampler 93. Recovery-r7 copy (r7 harness/producer,
# r6 wrapper, ported suites): reanchor-recovery 25, r3-regression 27, r62-isolated 2. NOT run: recovery-existing 34 (wrapper byte-identical
# to r6, passed in r6 0549); JS core 20 (core unchanged since r2 0234).
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/r7; R7=$P/base-reanchor-recovery-stage/r7; DEPS=$P/source
OUT=$ST/logs/root-finality-r7-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## finality-r7 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "r7 files differ from SHA256SUMS"
pin $B/r6-ops-fixes-r2/SHA256SUMS 22c3f86560716cac7f8c7c30761592c8aea35eb61310fe0e20fe76f8d2314ef6; pin $B/r6-followup-fixes/SHA256SUMS 3ad56bb1611284fe4a9ebe93fde18dae5b60828f7a74500ab6682d845e74ca7d; pin $B/r6-test-fixes/SHA256SUMS 23bffb8606ab4bc8b84a1a9ddb6b811dcc01d4abb1c300e32bd52db35e7c72e1; pin $B/r6/SHA256SUMS 1655f54f72c3b1416687cdb50e34f2c868a328010036c23d98848a73be08406c; pin $R7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb
pin $P/coverage-stage/origin_extract.py 6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c
for d in $B/r6-ops-fixes-r2 $B/r6-followup-fixes $B/r6-test-fixes $B/r6; do (cd $d && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
(cd $R7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
# composition: every copy is byte-identical to its origin; every edit is origin + its patch
T=$OUT/tmp/pc
tail -n +2 $ST/COMPOSITION.tsv | while IFS=$'\t' read -r path h kind origin patch; do
  case "$kind" in
    copy) cmp -s "$B/$origin/$path" "$ST/$path" || { echo "## SETUP: $path is not the $origin copy"; exit 9; } ;;
    edit) b="$B/$origin/$path"; [ -f "$b" ] || b="$B/$origin/tests/r7-ported/$(basename $path)"
          rm -rf $T; mkdir -p $T && cp "$b" $T/x && (cd $T && patch -s x < "$ST/integration/$patch.patch") && cmp -s $T/x "$ST/$path" || { echo "## SETUP: $path != $origin + $patch"; exit 9; } ;;
  esac; done || die "composition check"
H=$(sha256sum < $ST/harness/a2a4.py | cut -c1-64); F=$(sha256sum < $ST/src/finality_state.py | cut -c1-64); Pr=$(sha256sum < $ST/producer/base_launch.py | cut -c1-64); Wr=$(sha256sum < $ST/wrapper/chain_service.py | cut -c1-64)
grep -q "HARNESS_SHA256 = '$H'" $ST/src/finality_state.py && grep -q "RECOVERY_A2A4_SHA256 = '$H'" $ST/producer/base_launch.py && grep -q "FINALITY_STATE_SHA256 = '$F'" $ST/producer/base_launch.py \
  && grep -q "WRAPPER_SHA256 = '$Wr'" $ST/src/finality_state.py && grep -q "WRAPPER_SHA256 = '$Wr'" $ST/producer/base_launch.py \
  && grep -q "'$F')" $ST/src/reproof.py && grep -q "'$Pr')" $ST/src/reproof.py || die "byte pins are not consistent"
grep -qx 'A1_CAPTURE_REVIEWED = False' $ST/harness/a2a4.py && grep -qx 'FINALITY_PROOF_REVIEWED = False' $ST/producer/base_launch.py && grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' $ST/wrapper/chain_service.py \
  && grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' $ST/src/finality_state.py && grep -q '^RETH_ENV_PASS = ()' $ST/harness/a2a4.py \
  && grep -q "^HARNESS_BINARY_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'" $ST/producer/base_launch.py || die "a flag or a production pin changed"
/usr/bin/python3 -I - $ST <<'PYM' || die "install manifest does not name the stage's exact bytes"
import hashlib, json, pathlib, sys
S = pathlib.Path(sys.argv[1]); m = json.loads((S / 'install/MANIFEST.json').read_bytes())
for e in m['files']:
    p = pathlib.Path(e['src']) if e['src'].startswith('/') else S / e['src']
    assert hashlib.sha256(p.read_bytes()).hexdigest() == e['sha256'], e['src']
PYM
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests?' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
SC=$OUT/stage; mkdir -p "$SC" && (cd "$ST" && tar --exclude=./logs -cf - .) | (cd "$SC" && tar -xf -) || die "stage copy"
E=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$P)
for s in tool:test_finality_state.py:34:1200 integration:test_finality_integration.py:17:3000 reproof:test_reproof.py:5:3000 ops-readiness:test_ops_readiness.py:27:600 ops-installer:test_ops_installer.py:13:600; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
SR=$OUT/sampler; mkdir -p $SR/readiness $SR/coverage && cp $ST/readiness/*.py $SR/readiness/ && cp $P/coverage-stage/origin_extract.py $SR/coverage/ || die "sampler layout"
(cd $SR/readiness && "${E[@]}" timeout 1200 /usr/bin/python3 -I -B test_readiness_sampler.py < /dev/null) > $OUT/sampler.txt 2>&1; check sampler 93 $?
C=$OUT/r7-recovery; cp -a $R7 $C && rm -rf $C/logs/* && find $C -name __pycache__ -prune -exec rm -rf {} + || die "r7 copy"
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/*.py $ST/tests/test_r62_followups.py $C/tests/ || die "r7 copy swap"
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 25 $?
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 27 $?
(cd $C && env TMPDIR=$OUT/tmp FINALITY_SRC=$ST/src timeout 600 /usr/bin/python3 -E -s -B -u tests/test_r62_followups.py < /dev/null) > $OUT/r62-isolated.txt 2>&1; check r62-isolated 2 $?
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r7 files CHANGED during the run"
echo "## outputs: $OUT"; echo "## r7 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r7 rc=$rc"; exit $rc
