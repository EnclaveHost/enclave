#!/bin/bash
# base-finality-proof-stage/r8 (PREPARED; NOT run by Claude). Through the queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r8
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1024 --log $ST/logs/root-finality-r8-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r8-tests.sh > $ST/logs/root-finality-r8-tests.out 2>&1; echo $? > $ST/logs/root-finality-r8-tests.rc
# ONLY suites whose bytes changed vs their last root run (exact count from the unittest summary 'Ran N' + final 'OK', no skip, rc 0;
# anything else prints FAIL with its log - never relabeled):
#   stage copy: tool 34 (tool pin), integration 17 (harness+tool pins), reproof 9 (ordering + 4 regressions), ops-readiness 27 (pinned
#   baseline, no skip), ops-installer 13 (manifest); recovery-r7 copy: reanchor-recovery 25 (pinned-format fake), r3-regression 27 (producer),
#   r62-isolated 2 (harness), forward-sync 8 + forward-sync-r2 6 (forward_sync pin, producer).
# DEPENDENCIES on identical bytes, not repeated (reported PENDING -> rc 3 while absent): sampler 93 (readiness bytes == r7; r7 run 0624),
#   parser 8 (harness == pinned-checkpoint-parser stage harness 501219fd; its root job).
# Exit: 0 all PASS and dependencies present | 1 a FAIL | 3 all PASS, a dependency pending | 9 setup.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/r8; RR7=$P/base-reanchor-recovery-stage/r7; F2=$P/base-forward-sync-stage/r2; PS=$B/pinned-checkpoint-parser
DEPS=$P/source; FAKE=$PS/fixtures/fake_base.py; HELP=$P/logs/base-live-help-0603/help.txt
OUT=$ST/logs/root-finality-r8-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0; pend=0
die() { echo "## SETUP: $*"; echo "## finality-r8 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "r8 files differ from SHA256SUMS"
pin $B/r7/SHA256SUMS e1af48ad3fd972e281e0136a1438da36850e8089066ae4695dcba8241de1fa3c; pin $PS/SHA256SUMS 96dd0d602ebe246d118453db7ae1c23aa1ac8849e7d5eae8b468248b362ecb86; pin $F2/SHA256SUMS 0626b9e4c03997a5fa81507916052e4fac0af68263b41d96ad23b942101d80ff; pin $B/r6/SHA256SUMS 1655f54f72c3b1416687cdb50e34f2c868a328010036c23d98848a73be08406c; pin $RR7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb
pin $FAKE 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802; pin $HELP d393bab10e34092808652c18356a14495f236474efc2408f346afd4886f38025; pin $P/coverage-stage/origin_extract.py 6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c
for d in $B/r7 $PS $F2 $B/r6; do (cd $d && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
(cd $RR7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
T=$OUT/tmp/pc
origin() { case "$1" in r7) echo "$B/r7/$2";; parser:*) echo "$PS/${1#parser:}";; fs-r2:*) echo "$F2/${1#fs-r2:}";; esac; }
tail -n +2 $ST/COMPOSITION.tsv | while IFS=$'\t' read -r path h kind o patch; do
  case "$kind" in
    copy) cmp -s "$(origin $o $path)" "$ST/$path" || { echo "## SETUP: $path is not the $o copy"; exit 9; } ;;
    edit) rm -rf $T; mkdir -p $T && cp "$(origin $o $path)" $T/x && (cd $T && patch -s x < "$ST/integration/$patch.patch") && cmp -s $T/x "$ST/$path" \
            || { echo "## SETUP: $path != $o + $patch"; exit 9; } ;;
  esac; done || die "composition check"
H=$(sha256sum < $ST/harness/a2a4.py | cut -c1-64); F=$(sha256sum < $ST/src/finality_state.py | cut -c1-64); Pr=$(sha256sum < $ST/producer/base_launch.py | cut -c1-64); Wr=$(sha256sum < $ST/wrapper/chain_service.py | cut -c1-64)
[ "$H" = 501219fd9ddbce4c3bd0a90e57ed782ebef0de9e357865a51b979dc93e7bd464 ] || die "harness is not the pinned-checkpoint-parser harness"
grep -q "HARNESS_SHA256 = '$H'" $ST/src/finality_state.py && grep -q "RECOVERY_A2A4_SHA256 = '$H'" $ST/producer/base_launch.py && grep -q "a2a4.py'), '$H')" $ST/recovery/forward_sync.py \
  && grep -q "FINALITY_STATE_SHA256 = '$F'" $ST/producer/base_launch.py && grep -q "'$F')" $ST/src/reproof.py && grep -q "'$Pr')" $ST/src/reproof.py \
  && grep -q "WRAPPER_SHA256 = '$Wr'" $ST/src/finality_state.py && grep -q "WRAPPER_SHA256 = '$Wr'" $ST/producer/base_launch.py && grep -q "chain_service.py'), '$Wr')" $ST/recovery/forward_sync.py \
  || die "byte pins are not consistent"
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
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE '^OK \(|skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
SC=$OUT/stage; mkdir -p $SC && (cd $ST && tar --exclude=./logs -cf - .) | (cd $SC && tar -xf -) && mkdir -p $SC/logs || die "stage copy (no recursion: logs excluded)"
E=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$P)
for s in tool:test_finality_state.py:34:1200 integration:test_finality_integration.py:17:3000 reproof:test_reproof.py:9:3600 ops-readiness:test_ops_readiness.py:27:600 ops-installer:test_ops_installer.py:13:600; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
C=$OUT/r7-recovery; mkdir -p $C && (cd $RR7 && tar --exclude=./logs --exclude='__pycache__' -cf - .) | (cd $C && tar -xf -) && mkdir -p $C/logs || die "recovery copy"
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/*.py $ST/tests/test_r62_followups.py $ST/tests/forward-sync/test_forward_sync.py $C/tests/ || die "recovery copy swap"
RE=(env TMPDIR=$OUT/tmp PINNED_FAKE_BASE=$FAKE)
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 25 $?
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 27 $?
(cd $C && "${RE[@]}" FINALITY_SRC=$ST/src timeout 600 /usr/bin/python3 -E -s -B -u tests/test_r62_followups.py < /dev/null) > $OUT/r62-isolated.txt 2>&1; check r62-isolated 2 $?
(cd $C && "${RE[@]}" FORWARD_SYNC_SRC=$ST/recovery timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_forward_sync.py < /dev/null) > $OUT/forward-sync.txt 2>&1; check forward-sync 8 $?
(cd $ST && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FORWARD_SYNC_SRC=$ST/recovery R2_PRODUCER=$ST/producer/base_launch.py BASE_HELP=$HELP \
   timeout 600 /usr/bin/python3 -I -B tests/forward-sync/test_forward_sync_r2.py -v < /dev/null) > $OUT/forward-sync-r2.txt 2>&1; check forward-sync-r2 6 $?
grep -hqE '^PASS sampler Ran 93 ' $P/logs/root-finality-r7-*.out 2>/dev/null && echo "DEPENDENCY sampler 93: PASS (r7 run, identical readiness bytes)" || { echo "DEPENDENCY sampler 93: PENDING"; pend=1; }
PR=$P/logs/root-pinned-checkpoints-0626      # root's queued parser job receipt (logs/root-pinned-checkpoints-0626.{out,rc})
[ "$(cat $PR.rc 2>/dev/null)" = 0 ] && grep -qE '^Ran 8 tests? in ' $PR.out && [ "$(grep -E '^(OK|FAILED)( |$)' $PR.out | tail -1)" = OK ] \
  && echo "DEPENDENCY parser 8: PASS (identical harness 501219fd)" || { echo "DEPENDENCY parser 8: PENDING ($PR.rc/.out not rc 0 with 'Ran 8' + OK)"; pend=1; }
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r8 files CHANGED during the run"
[ $rc = 0 ] && [ $pend = 1 ] && rc=3
echo "## outputs: $OUT"; echo "## r8 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r8 rc=$rc"; exit $rc
