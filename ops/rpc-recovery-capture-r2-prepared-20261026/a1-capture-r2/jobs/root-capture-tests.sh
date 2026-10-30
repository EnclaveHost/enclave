#!/bin/bash
# a1-capture-binding-stage/r2: root's LOCAL, OFFLINE test job (PREPARED; NOT run by Claude). Foreground:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r2
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
# No Helios, no L1, no network: the capture runs over stubs (tests/stubs) with their actual bytes as pins; production pins are
# compared with the real reviewed sources; the real pinned A1 gate runs over root's real captured receipts (read only).
# PASS only if: SHA256SUMS verifies before and after; no network route; `Ran 36 tests` + final `OK`, no skip, rc 0; the three
# HOLD flags are still False (launcher r3 x2 read only, finality prototype). Anything else (timeout 124, unknown exit) fails.
set -uo pipefail
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/a1-capture-binding-stage/r2; OPS=$P/source/ops/rpc-backend-bootstrap/2026-10-25
OUT=$ST/logs/root-capture-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## INVALID: $*"; echo "## capture rc=1"; exit 1; }
fail() { echo "## FAIL: $*"; rc=1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
NODE=$(realpath -e "$(command -v node)") || die "node not found"
"$NODE" --version > "$OUT/node.version" || die "node does not run"
grep -qx 'FINALITY_PROOF_REVIEWED = False' "$P/base-launch-producer-stage/r3/producer/base_launch.py" || fail "launcher r3 FINALITY_PROOF_REVIEWED is not False"
grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' "$P/base-launch-producer-stage/r3/wrapper/chain_service.py" || fail "launcher r3 LAUNCH_PRODUCER_REVIEWED is not False"
grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' "$P/base-finality-proof-stage/src/finality_state.py" || fail "prototype FINALITY_PROTOTYPE_REVIEWED is not False"
# TMPDIR on disk: every capture copies the real node binary (~56 MB) into its private directory. The Runtime tests require
# THIS host's node/python/libpython to be the operator-observed accepted runtimes (a different runtime FAILS: intended)
(cd "$ST" && env -i PATH=/usr/bin:/bin TMPDIR="$OUT/tmp" A1_NODE="$NODE" A1_OPS="$OPS" A1_DEPS_ROOT="$P/source" \
   A1_L1_AUTHORITY="$P/finality-stage/l1-authority/l1_authority.py" timeout 1800 python3 -I -B tests/test_a1_capture.py -v < /dev/null) > "$OUT/py.txt" 2>&1
echo $? > "$OUT/py.rc"
grep -qx 'Ran 36 tests in [0-9.]*s' "$OUT/py.txt" || fail "not exactly 36 tests"
[ "$(grep -E '^(OK|FAILED)' "$OUT/py.txt" | tail -1)" = OK ] || fail "final line is not exactly OK (no skips allowed)"
grep -q '\.\.\. skipped' "$OUT/py.txt" && fail "a skipped test"
[ "$(cat "$OUT/py.rc")" = 0 ] || fail "rc $(cat "$OUT/py.rc")"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
echo "## outputs: $OUT"; echo "## capture rc=$rc"; exit $rc
