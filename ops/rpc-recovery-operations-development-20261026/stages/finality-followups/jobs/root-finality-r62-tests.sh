#!/bin/bash
# base-finality-proof-stage/r6-followup-fixes (r6.2): root's LOCAL, OFFLINE job (PREPARED; NOT run by Claude). Through the existing queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r6-followup-fixes
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r62-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r62-tests.sh > $ST/logs/root-finality-r62-tests.out 2>&1; echo $? > $ST/logs/root-finality-r62-tests.rc
# Runs ONLY: (1) integration, 4 named cases (root's 2 failed + the 2 adoption cases whose path changed); (2) the 2 isolated r6.2 tests;
# (3) reanchor-recovery 24, because the clean reth environment changes every harness base-reth child call those tests drive.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; ST=$P/base-finality-proof-stage/r6-followup-fixes; R6=$P/base-finality-proof-stage/r6; TF=$P/base-finality-proof-stage/r6-test-fixes
R7=$P/base-reanchor-recovery-stage/r7; FSS=$P/base-forward-sync-stage; DEPS=$P/source
OUT=$ST/logs/root-finality-r62-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## finality-r62 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
pin $R6/SHA256SUMS 1655f54f72c3b1416687cdb50e34f2c868a328010036c23d98848a73be08406c; pin $R7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb; pin $FSS/SHA256SUMS 287a52f9b25e41dfc7e985041d2f4dcad4f2299ddd4c7d39a082910311c26072; pin $TF/SHA256SUMS 23bffb8606ab4bc8b84a1a9ddb6b811dcc01d4abb1c300e32bd52db35e7c72e1
for d in $R6 $FSS $TF; do (cd $d && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
(cd $R7 && sha256sum -c --quiet MANIFEST.sha256) || die "r7 changed"
T=$OUT/tmp/pc
chk() { rm -rf $T; mkdir -p $T && cp "$1" $T/x && (cd $T && patch -s x < "$ST/integration/$3.patch") && cmp -s $T/x "$ST/$2" || die "$2 != base + $3.patch"; }
chk $R6/harness/a2a4.py harness/a2a4.py harness-clean-reth-env
chk $R6/src/finality_state.py src/finality_state.py finality_state-node-acceptance-normalized
chk $FSS/r6-followup/producer/base_launch.py producer/base_launch.py producer-durable-adoption-on-r6.1
chk $TF/tests/test_finality_integration.py tests/test_finality_integration.py integration-rollback-and-adoption
chk $R6/tests/r7-ported/test_reanchor_recovery.py tests/r7-ported/test_reanchor_recovery.py r7-ported-fake-env-allowlist
H=$(sha256sum < $ST/harness/a2a4.py | cut -c1-64); F=$(sha256sum < $ST/src/finality_state.py | cut -c1-64)
grep -q "HARNESS_SHA256 = '$H'" $ST/src/finality_state.py && grep -q "RECOVERY_A2A4_SHA256 = '$H'" $ST/producer/base_launch.py \
  && grep -q "FINALITY_STATE_SHA256 = '$F'" $ST/producer/base_launch.py || die "byte pins are not consistent"
grep -qx 'A1_CAPTURE_REVIEWED = False' $ST/harness/a2a4.py && grep -qx 'FINALITY_PROOF_REVIEWED = False' $ST/producer/base_launch.py \
  && grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' $ST/src/finality_state.py && grep -q '^RETH_ENV_PASS = ()' $ST/harness/a2a4.py || die "a flag or the production reth allowlist changed"
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests?' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
F6=$OUT/r6.2; cp -a $R6 $F6 && rm -rf $F6/logs/* || die "r6 copy"
cp $ST/harness/a2a4.py $F6/harness/ && cp $ST/src/finality_state.py $F6/src/ && cp $ST/producer/base_launch.py $F6/producer/ \
  && cp $ST/tests/test_finality_integration.py $TF/tests/test_finality_state.py $F6/tests/ || die "r6 copy swap"
(cd $F6 && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$F6/harness/a2a4.py PRODUCER_WORK=$P \
   timeout 1800 /usr/bin/python3 -I -B tests/test_finality_integration.py -v Integration.test_capture_hold_and_unreviewed_tool_write_nothing \
   Integration.test_rollback_after_bootstrapped_is_terminal_and_rearm_never_allowed Integration.test_interrupted_record_is_adopted_after_a_node_restart \
   Integration.test_interrupted_record_is_adopted_never_a_trap < /dev/null) > $OUT/integration-4.txt 2>&1; check integration-4 4 $?
C=$OUT/r7-with-r6.2; cp -a $R7 $C && rm -rf $C/logs/* && find $C -name __pycache__ -prune -exec rm -rf {} + || die "r7 copy"
cp $ST/harness/a2a4.py $C/harness/ && cp $R6/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/test_reanchor_recovery.py $R6/tests/r7-ported/test_r3_launcher.py $ST/tests/test_r62_followups.py $C/tests/ || die "r7 copy swap"
(cd $C && env TMPDIR=$OUT/tmp FINALITY_SRC=$ST/src timeout 600 /usr/bin/python3 -E -s -B -u tests/test_r62_followups.py < /dev/null) > $OUT/r62-isolated.txt 2>&1; check r62-isolated 2 $?
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 24 $?
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
echo "## outputs: $OUT"; echo "## r62 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r62 rc=$rc"; exit $rc
