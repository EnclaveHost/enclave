#!/bin/bash
# base-forward-sync-stage: root's LOCAL, OFFLINE job (PREPARED; NOT run by Claude). Through the existing queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-forward-sync-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1024 --log $ST/logs/root-forward-sync-tests.guard -- unshare -rn bash $ST/jobs/root-forward-sync-tests.sh > $ST/logs/root-forward-sync-tests.out 2>&1; echo $? > $ST/logs/root-forward-sync-tests.rc
# EXECUTES ONLY what r6 run 0549 did not pass, plus this stage (exact counts, no skip, rc 0): in a PRIVATE COPY of finality r6 with the
# r6.1 follow-up (producer bound-binary fix + test fixture corrections): tool 34, integration 16; in a PRIVATE COPY of recovery r7 with
# the r6 harness/wrapper, the r6.1 producer and the r6 ported suites: reanchor-recovery 24, r3-regression 27, forward-sync 8.
# NOT repeated (passed in r6 0549): sampler 92, recovery-existing 34. Prints '## forward-sync rc=<rc>'.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; ST=$P/base-forward-sync-stage; R6=$P/base-finality-proof-stage/r6; R7=$P/base-reanchor-recovery-stage/r7; DEPS=$P/source
OUT=$ST/logs/root-forward-sync-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## forward-sync rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
[ "$(sha256sum < $R6/SHA256SUMS | cut -c1-64)" = 1655f54f72c3b1416687cdb50e34f2c868a328010036c23d98848a73be08406c ] && (cd $R6 && sha256sum -c --quiet SHA256SUMS) || die "finality r6 changed"
[ "$(sha256sum < $R7/MANIFEST.sha256 | cut -c1-64)" = 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb ] && (cd $R7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
T=$OUT/tmp/pc
chk() { rm -rf $T; mkdir -p $T && cp "$1" $T/x && (cd $T && patch -s x < "$ST/integration/$3.patch") && cmp -s $T/x "$ST/$2" || die "$2 != r6 + $3.patch"; }
chk $R6/producer/base_launch.py r6-followup/producer/base_launch.py r6-producer-bound-binary
chk $R6/tests/test_finality_state.py r6-followup/tests/test_finality_state.py r6-tool-test-expectations
chk $R6/tests/test_finality_integration.py r6-followup/tests/test_finality_integration.py r6-integration-boot-files
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests?' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
F6=$OUT/r6-followup; cp -a $R6 $F6 && rm -rf $F6/logs/* && cp $ST/r6-followup/producer/base_launch.py $F6/producer/ && cp $ST/r6-followup/tests/*.py $F6/tests/ || die "r6 copy"
ENVV=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$F6/harness/a2a4.py PRODUCER_WORK=$P)
(cd $F6 && "${ENVV[@]}" timeout 1200 /usr/bin/python3 -I -B tests/test_finality_state.py -v < /dev/null) > $OUT/tool.txt 2>&1; check tool 34 $?
(cd $F6 && "${ENVV[@]}" timeout 3000 /usr/bin/python3 -I -B tests/test_finality_integration.py -v < /dev/null) > $OUT/integration.txt 2>&1; check integration 16 $?
C=$OUT/r7-with-r6.1; cp -a $R7 $C && rm -rf $C/logs/* && find $C -name __pycache__ -prune -exec rm -rf {} + || die "r7 copy"
cp $R6/harness/a2a4.py $C/harness/ && cp $R6/wrapper/chain_service.py $C/wrapper/ && cp $ST/r6-followup/producer/base_launch.py $C/producer/ \
  && cp $R6/tests/r7-ported/test_reanchor_recovery.py $R6/tests/r7-ported/test_r3_launcher.py $ST/tests/test_forward_sync.py $C/tests/ || die "r7 copy swap"
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 24 $?
(cd $C && env TMPDIR=$OUT/tmp timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 27 $?
(cd $C && env TMPDIR=$OUT/tmp FORWARD_SYNC_SRC=$ST/src timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_forward_sync.py < /dev/null) > $OUT/forward-sync.txt 2>&1; check forward-sync 8 $?
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
echo "## outputs: $OUT"; echo "## forward-sync SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## forward-sync rc=$rc"; exit $rc
