#!/bin/bash
# a1-capture-binding-stage/r4: root's LOCAL, OFFLINE test job (PREPARED; NOT run by Claude). Foreground:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r4
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
# r4 = r3 (root PASS 45, logs/root-a1-capture-r3-0306) + the verified-bytes l1-authority loader + 7 import-safety tests.
# EVERY suite runs as an ORDINARY caller: `python3 -I` WITHOUT -B (env -i: no PYTHONDONTWRITEBYTECODE / PYTHONPYCACHEPREFIX), so
# bytecode writing is ON, as in the reanchor harness that exposed the defect. The suites run in a private copy ($OUT/run) so the
# caller's own caches never touch the stage; the copy is checked against SHA256SUMS first. Suites and EXACT counts:
#   capture        tests/test_a1_capture.py (r3's 45, byte-identical)                                  45
#   import-safety  tests/test_import_safety.py (new)                                                    7
# PASS only if: SHA256SUMS verifies (stage before/after, copy before); no network route; each suite `Ran <n> tests` + final `OK`,
# no skip, rc 0; the copy's src/__pycache__ EXISTS afterwards (proof the caller really wrote bytecode, i.e. no hidden -B); the
# three HOLD flags are still False. Anything else (timeout 124, unknown exit) fails.
set -uo pipefail
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/a1-capture-binding-stage/r4; OPS=$P/source/ops/rpc-backend-bootstrap/2026-10-25
OUT=$ST/logs/root-capture-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; RUN=$OUT/run; rc=0
die() { echo "## INVALID: $*"; echo "## capture rc=1"; exit 1; }
fail() { echo "## FAIL: $*"; rc=1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" "$RUN" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$ST" && tar --exclude=./logs -cf - .) | (cd "$RUN" && tar -xf -) || die "private copy"
(cd "$RUN" && sha256sum -c --quiet SHA256SUMS) || die "private copy differs from SHA256SUMS"
find "$RUN" -name __pycache__ | grep -q . && die "the private copy already holds bytecode caches"
NODE=$(realpath -e "$(command -v node)") || die "node not found"
"$NODE" --version > "$OUT/node.version" || die "node does not run"
grep -qx 'FINALITY_PROOF_REVIEWED = False' "$P/base-launch-producer-stage/r3/producer/base_launch.py" || fail "launcher r3 FINALITY_PROOF_REVIEWED is not False"
grep -qx 'LAUNCH_PRODUCER_REVIEWED = False' "$P/base-launch-producer-stage/r3/wrapper/chain_service.py" || fail "launcher r3 LAUNCH_PRODUCER_REVIEWED is not False"
grep -q '^FINALITY_PROTOTYPE_REVIEWED = False ' "$P/base-finality-proof-stage/src/finality_state.py" || fail "prototype FINALITY_PROTOTYPE_REVIEWED is not False"
suite() { local label=$1 want=$2 file=$3
  (cd "$RUN" && env -i PATH=/usr/bin:/bin TMPDIR="$OUT/tmp" A1_NODE="$NODE" A1_OPS="$OPS" A1_DEPS_ROOT="$P/source" \
     A1_L1_AUTHORITY="$P/finality-stage/l1-authority/l1_authority.py" \
     A1_LIVE_CAPTURE=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/a1-capture-live-0252/initial \
     timeout 1800 python3 -I "$file" -v < /dev/null) > "$OUT/$label.txt" 2>&1
  local r=$?; echo $r > "$OUT/$label.rc"
  grep -qx "Ran $want tests in [0-9.]*s" "$OUT/$label.txt" || fail "$label: not exactly $want tests"
  [ "$(grep -E '^(OK|FAILED)' "$OUT/$label.txt" | tail -1)" = OK ] || fail "$label: final line is not exactly OK (no skips allowed)"
  grep -qE '\.\.\. (skipped|expected failure|unexpected success)' "$OUT/$label.txt" && fail "$label: a skipped/expected-failure test"
  [ "$r" = 0 ] || fail "$label: rc $r"
  echo "## $label rc=$r"; }
suite capture 45 tests/test_a1_capture.py
suite import-safety 7 tests/test_import_safety.py
[ -d "$RUN/src/__pycache__" ] || fail "no src/__pycache__ in the copy: the caller did not write bytecode (hidden -B?)"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
find "$ST" -path "$ST/logs" -prune -o -name __pycache__ -print | grep -q . && fail "bytecode caches appeared in the stage itself"
echo "## outputs: $OUT"; echo "## capture rc=$rc"; exit $rc
