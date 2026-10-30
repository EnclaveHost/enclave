#!/bin/bash
# r6-test-fixes (TEST-ONLY; PREPARED, NOT run by Claude). Frozen r6 is never edited: it is verified, copied (without logs) into this
# run's private directory, and ONLY tests/test_finality_state.py + tests/test_finality_integration.py are swapped for the pinned fixed
# copies (= r6 + patches/*.patch). Executes ONLY: the 4 failed tool cases (exact names) and the never-run integration suite (16).
# Root, from work/rpc-production-final-20261025 (queue 1024, foreground):
#   python3 -u ../claude-test-queue.py --mib 1024 --log base-finality-proof-stage/r6-test-fixes/logs/root-finality-r6-fixes.guard -- unshare -rn bash base-finality-proof-stage/r6-test-fixes/jobs/root-finality-r6-fixes.sh
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R6=$P/base-finality-proof-stage/r6; FX=$P/base-finality-proof-stage/r6-test-fixes; DEPS=$P/source
L6=$R6/logs/root-finality-r6-tests-20261026T054735Z-964702
OUT=$FX/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## r6-test-fixes rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$R6" && sha256sum -c --quiet SHA256SUMS) || die "frozen r6 differs from its SHA256SUMS"
(cd "$FX" && sha256sum -c --quiet SHA256SUMS) || die "r6-test-fixes differs from its SHA256SUMS"
pin $R6/tests/test_finality_state.py 78bf40d4e8c04d735280309b669d3b8b597349b11e25e7b9fee510b17f8ca71e
pin $R6/tests/test_finality_integration.py 595df4c44d5b1e8c878b0add9d35637a4d63305a8c05d3a2fd8ab7820314d159
pin $FX/tests/test_finality_state.py d21f67feba0d70f9c2d8b62ae410453bc646f9bb58c3a001fc693841694ae350
pin $FX/tests/test_finality_integration.py 58d7a9e6084ee5e069e3a2d90140a2bd55094f3cd7ae32e96f8b73c9ace47213
for f in test_finality_state test_finality_integration; do T=$OUT/tmp/pc-$f; mkdir -p $T && cp $R6/tests/$f.py $T/x && (cd $T && patch -s x < $FX/patches/$f.patch) && cmp -s $T/x $FX/tests/$f.py || die "$f fixed copy != r6 + patch"; done
# reuse evidence: root's actual r6 tool run (34 ran; 30 ok = every case except the 4 rerun here)
pin $L6/tool.txt 8f217ae616181a791471900a5aa726b3775034d9a41d7c4185a8985e19bd8307
[ "$(grep -cE ' \.\.\. ok$' $L6/tool.txt)" = 30 ] && grep -qx 'Ran 34 tests in [0-9.]*s' $L6/tool.txt || die "r6 tool log is not 34 ran / 30 ok"
S=$OUT/stage; mkdir -p $S && (cd $R6 && tar --exclude=./logs -cf - .) | (cd $S && tar -xf -) || die "private copy"
cp $FX/tests/test_finality_state.py $FX/tests/test_finality_integration.py $S/tests/ || die "swap"
NODE=$(realpath -e "$(command -v node)") || die "node not found"
ENVV=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$S/harness/a2a4.py PRODUCER_WORK=$P)
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests?' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
(cd $S && "${ENVV[@]}" timeout 1200 /usr/bin/python3 -I -B tests/test_finality_state.py -v \
   Gates.test_published_status_is_what_the_readiness_gate_requires Gates.test_no_proof_status_is_none_and_a_missing_a1_dir_refuses \
   Gates.test_revoked_then_truncated_stays_terminal Gates.test_status_survives_only_the_bootstrapped_event_naming_this_entry < /dev/null) > $OUT/tool-4.txt 2>&1; check tool-4 4 $?
(cd $S && "${ENVV[@]}" timeout 3000 /usr/bin/python3 -I -B tests/test_finality_integration.py -v < /dev/null) > $OUT/integration.txt 2>&1; check integration 16 $?
(cd "$R6" && sha256sum -c --quiet SHA256SUMS) || fail "frozen r6 CHANGED during the run"
(cd $OUT && sha256sum tool-4.txt integration.txt > RECEIPTS.sha256)
echo "## tool: 30 reused from r6 tool.txt (8f217ae6) + 4 executed; integration 16 executed. NOT covered here: reanchor-recovery/r3-regression (see report)"
echo "## r6-test-fixes rc=$rc"; exit $rc
