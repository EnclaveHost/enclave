#!/bin/bash
# cold-proof-timeout-stage/r3: root's LOCAL, OFFLINE test job. r1/r2 frozen and superseded (r1: no post-run budget; r2: spawnSync CLI
# deadlock in the test, fractional AbortSignal timeout). Claude was authorized to run THIS job only (queue 512, unshare -Urn).
#   python3 -u ../claude-test-queue.py --mib 256 --log cold-proof-timeout-stage/r3/logs/root-cold-proof-tests.guard -- unshare -rn bash cold-proof-timeout-stage/r3/jobs/root-cold-proof-tests.sh
# Three suites, all in a private 0700 dir removed on ANY exit (no network; mocks bind 127.0.0.1):
#   1 tests/test_cold_proof_transport.mjs, exactly 13 (fractional budget flooring + async real CLIs of BOTH readers; deadline classes, monotonic total budget incl. AFTER the last request, no retry,
#     envelope/size, malformed proofs, loopback, stale/future/missing-timestamp after read, both readers wired through finishRead);
#   2 the EXISTING pinned A1 suite l1-anchor-a1/test/a1-anchor.test.mjs (runA1 malformed/forged-proof/stale/future/finality refusals +
#     a1-read rpc()/loopback/byte-cap/timeout) run on the pinned ORIGINAL tree (baseline) and on the tree with THIS stage's readers:
#     the overlay must pass with the same pass count and 0 fail;
#   3 the EXISTING pinned original-game suite a1-recheck.test.mjs on the pinned tree (its policy code a1-recheck.mjs/a1-anchor.mjs is
#     byte-identical in the fix; its "pinned reuse" test pins the OLD a1-read sha, which this fix intentionally re-pins via the cascade).
# Source trees are verified against their own SHA256SUMS and their policy files against r12-final's bundle-origin shas.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/cold-proof-timeout-stage/r3; F=$P/base-finality-proof-stage/r12-final
A=$P/source/ops/rpc-backend-bootstrap/2026-10-25
CFG=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/a1-capture-live-0252/initial/capture/inputs/a1-config.json
OUT=$S/logs/cold-proof-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; PW=""; rc=0
die() { echo "## SETUP: $*"; echo "## cold-proof-tests rc=9"; exit 9; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
trap '[ -n "$PW" ] && rm -rf --one-file-system -- "$PW"' EXIT
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r3 != SHA256SUMS"; SUMS=$(sha256sum < $S/SHA256SUMS | cut -c1-64)
pin $F/SHA256SUMS 9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e
pin $CFG e72f271ea0c7a4a691f0260303fd12639b60c916dcf76ff6c4dd6d479a0811d1
pin $P/source/package-lock.json 9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20
pin $A/l1-anchor-a1/SHA256SUMS 0633977792cdc487585a133f472e3fc560b168d038d16c2e6d7b6bd4f67ede25
pin $A/a1-original-game-prepared/SHA256SUMS 929f1f5c8cf8a3badf08d790348c66bbd383f347effa121a481dd12a1ca2f701
for d in l1-anchor-a1 a1-original-game-prepared; do (cd $A/$d && sha256sum -c --quiet SHA256SUMS) || die "$d differs from its SHA256SUMS"; done
python3 -I - $F/bundle-origin.json $A <<'PY' || die "source policy files are not the r12-final-pinned bytes"
import hashlib, json, pathlib, sys
bo = json.loads(pathlib.Path(sys.argv[1]).read_text())['entries']; A = pathlib.Path(sys.argv[2])
for d in ('l1-anchor-a1', 'a1-original-game-prepared'):
    for k, e in bo.items():
        pre = f'bundle/a1-capture/{d}/'
        if k.startswith(pre) and 'sha256' in e and not k.endswith(('a1-read.mjs', 'a1-recheck-read.mjs')):
            assert hashlib.sha256((A / d / k[len(pre):]).read_bytes()).hexdigest() == e['sha256'], k
print('policy files == r12-final pins')
PY
[ ! -e "$OUT" ] && mkdir -p "$OUT" || die "output dir"
PW=$(mktemp -d /tmp/coldproof3.XXXXXXXX) && chmod 0700 $PW || die "private dir"
for v in orig new; do for d in l1-anchor-a1 a1-original-game-prepared; do mkdir -p $PW/$v/$d && (cd $A/$d && tar -cf - $(sed 's#^[0-9a-f]*  \./##' SHA256SUMS | grep -E '^(a1-[a-z-]+\.mjs|vendor/|test/)')) | (cd $PW/$v/$d && tar -xf -) || die "tree $v/$d"; done; done
cp $S/src/l1-anchor-a1/a1-read.mjs $PW/new/l1-anchor-a1/a1-read.mjs && cp $S/src/a1-original-game-prepared/a1-read.mjs $S/src/a1-original-game-prepared/a1-recheck-read.mjs $PW/new/a1-original-game-prepared/ || die overlay
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
E=(env -i PATH=/usr/bin:/bin TMPDIR=$PW HOME=$PW ANCHOR_DEPS_ROOT=$P/source)
cnt() { grep -oE "^# $2 [0-9]+" $1 | grep -oE '[0-9]+'; }
clean() { [ "$(cnt $1 fail)" = 0 ] && [ -z "$(grep -E '^# (skipped|todo|cancelled) [1-9]' $1)" ]; }
(cd $S && "${E[@]}" A1_DIR=$PW/new/l1-anchor-a1 RECHECK_DIR=$PW/new/a1-original-game-prepared CFG=$CFG timeout 600 $NODE --test --test-reporter=tap tests/test_cold_proof_transport.mjs < /dev/null) > $OUT/cold-proof-transport.txt 2>&1; r1=$?
(cd $PW/orig/l1-anchor-a1 && "${E[@]}" timeout 600 $NODE --test --test-reporter=tap test/a1-anchor.test.mjs < /dev/null) > $OUT/a1-anchor-baseline.txt 2>&1; r2=$?
(cd $PW/new/l1-anchor-a1 && "${E[@]}" timeout 600 $NODE --test --test-reporter=tap test/a1-anchor.test.mjs < /dev/null) > $OUT/a1-anchor-new-reader.txt 2>&1; r3=$?
(cd $PW/orig/a1-original-game-prepared && "${E[@]}" timeout 600 $NODE --test --test-reporter=tap test/a1-recheck.test.mjs < /dev/null) > $OUT/a1-recheck-policy.txt 2>&1; r4=$?
T=$(cnt $OUT/cold-proof-transport.txt pass); B=$(cnt $OUT/a1-anchor-baseline.txt pass); N=$(cnt $OUT/a1-anchor-new-reader.txt pass); G=$(cnt $OUT/a1-recheck-policy.txt pass)
[ $r1 = 0 ] && [ "$T" = 13 ] && clean $OUT/cold-proof-transport.txt || { echo "## FAIL: cold-proof-transport rc $r1 pass ${T:-?} (expected 13)"; rc=1; }
[ $r2 = 0 ] && [ -n "$B" ] && [ "$B" -gt 0 ] && clean $OUT/a1-anchor-baseline.txt || { echo "## FAIL: a1-anchor baseline (pinned original) rc $r2 pass ${B:-?}"; rc=1; }
[ $r3 = 0 ] && [ "$N" = "$B" ] && clean $OUT/a1-anchor-new-reader.txt || { echo "## FAIL: a1-anchor with the new reader rc $r3 pass ${N:-?} (baseline ${B:-?})"; rc=1; }
[ $r4 = 0 ] && [ -n "$G" ] && [ "$G" -gt 0 ] && clean $OUT/a1-recheck-policy.txt || { echo "## FAIL: a1-recheck policy suite rc $r4 pass ${G:-?}"; rc=1; }
[ $rc = 0 ] && echo "PASS cold-proof-tests r3 transport 13 a1-anchor $N/$B a1-recheck $G stage-sums $SUMS" | tee $OUT/RESULT
echo "## cold-proof-tests r3 rc=$rc"; exit $rc
