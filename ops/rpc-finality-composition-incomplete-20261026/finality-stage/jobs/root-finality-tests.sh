#!/bin/bash
# base-finality-proof-stage: root's LOCAL, OFFLINE test job (PREPARED; NOT run by Claude). Foreground:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $ST/logs/root-finality-tests.guard -- unshare -rn bash $ST/jobs/root-finality-tests.sh > $ST/logs/root-finality-tests.out 2>&1; echo $? > $ST/logs/root-finality-tests.rc
# PASS only if: stage files equal SHA256SUMS (before and after); no network route; the dependency and A1-runner pins hold;
# JS core suite exactly 20 tests / 20 pass / 0 fail, skipped, todo, cancelled, rc 0; Python suite exactly `Ran 27 tests` + `OK`,
# no skip, rc 0; both launcher HOLD flags still False in base-launch-producer-stage/r2 (read only) and this prototype's own
# FINALITY_PROTOTYPE_REVIEWED False. Any other result - including a timeout (124) or any unknown exit - is a failure.
set -uo pipefail
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/base-finality-proof-stage; DEPS=$P/source
A1_RUNNER=$P/source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1/live-1958/run.py
OUT=$ST/logs/root-finality-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## INVALID: $*"; echo "## finality rc=1"; exit 1; }
fail() { echo "## FAIL: $*"; rc=1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
"$NODE" --version > "$OUT/node.version" || die "node does not run"
python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1]))["version"]; sys.exit(v!="1.8.0")' "$DEPS/node_modules/@noble/hashes/package.json" || die "@noble/hashes at $DEPS is not 1.8.0"
[ "$(sha256sum < "$A1_RUNNER" | cut -c1-64)" = b3044bbf9da1346da56837dcab7504b6e0bcb357c80cc13fc044e04266130210 ] || die "the reviewed A1 runner run.py differs from its pin"
grep -qx 'FINALITY_PROOF_REVIEWED = False' "$P/base-launch-producer-stage/r2/producer/base_launch.py" || fail "launcher r2 FINALITY_PROOF_REVIEWED is not False"
grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' "$P/base-launch-producer-stage/r2/wrapper/chain_service.py" || fail "launcher r2 LAUNCH_PRODUCER_REVIEWED is not False"
grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' "$ST/src/finality_state.py" || fail "this prototype's FINALITY_PROTOTYPE_REVIEWED is not False"
# --- JS core (adversarial, synthetic chain hashed by the reviewed vendor module)
(cd "$ST" && env -i PATH=/usr/bin:/bin ANCHOR_DEPS_ROOT="$DEPS" timeout 900 "$NODE" --test --test-reporter=tap tests/finality-core.test.mjs < /dev/null) > "$OUT/js.tap" 2>&1; echo $? > "$OUT/js.rc"
for kv in "tests 20" "pass 20" "fail 0" "cancelled 0" "skipped 0" "todo 0"; do grep -qx "# $kv" "$OUT/js.tap" || fail "JS: '# $kv' missing"; done
[ "$(cat "$OUT/js.rc")" = 0 ] || fail "JS rc $(cat "$OUT/js.rc")"
# --- Python root tool (fake /proc, fake wrapper journal; 3 e2e cases over the REAL core and a loopback stub)
(cd "$ST" && env -i PATH=/usr/bin:/bin FINALITY_NODE="$NODE" ANCHOR_DEPS_ROOT="$DEPS" FINALITY_A1_RUNNER="$A1_RUNNER" \
   timeout 900 python3 -I -B tests/test_finality_state.py -v < /dev/null) > "$OUT/py.txt" 2>&1; echo $? > "$OUT/py.rc"
grep -qx 'Ran 27 tests in [0-9.]*s' "$OUT/py.txt" || fail "Python: not exactly 27 tests"
[ "$(grep -E '^(OK|FAILED)' "$OUT/py.txt" | tail -1)" = OK ] || fail "Python: final line is not exactly OK (no skips allowed)"
grep -q '\.\.\. skipped' "$OUT/py.txt" && fail "Python: a skipped test"
[ "$(cat "$OUT/py.rc")" = 0 ] || fail "Python rc $(cat "$OUT/py.rc")"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
echo "## outputs: $OUT"; echo "## finality rc=$rc"; exit $rc
