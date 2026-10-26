#!/bin/bash
# retention-live-controller-stage/r2: ROOT offline qualification of the r2 controller (PREPARED; not run by Claude). No ssh, no guest:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   jobs/q-exit-status.sh retention-controller-r2-offline-1 512 unshare -Urn bash retention-live-controller-stage/r2/jobs/root-controller-offline.sh
# 1 pins: this r2 SHA256SUMS; the frozen r1 stage d17f0683 unchanged; activation-r2 409b8ed2 unchanged (only read).
# 2 baseline: the frozen activation-r2 suite test_retention_guard (15, unmodified), in place, read-only (-B; sums re-checked after).
# 3 the ACTUAL r2 shell controller under tests/test_controller.py (14): fake guest via the SSH override, controlled MemAvailable file,
#   POLL 1 s, scaled hours. Orchestration/ownership only; no evidence about the real guest, unit or download.
# PASS needs exactly 15 and 14 tests run, 0 failures/errors/skips. Bounded: 512 MiB queue, 900 s per suite, network namespace.
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/retention-live-controller-stage/r2; R1=$P/retention-live-controller-stage; A=$P/base-retention-stage/activation-r2
OUT=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PT=""; rc=0
die() { echo "## SETUP: $*"; echo "## retention-controller-r2-offline rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
trap '[ -n "$PT" ] && rm -rf -- "$PT"' EXIT
mkdir -p "$OUT" || exit 9
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -v '127.0.0.0/8\|dev lo' | grep -q . && die "network route present: run under unshare -Urn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r2 != SHA256SUMS"
[ "$(sha256sum < $R1/SHA256SUMS | cut -c1-64)" = d17f068391d38178de7c802215a5a07e73866e7fcb1d56910e3f5ded1109b733 ] && (cd $R1 && sha256sum -c --quiet SHA256SUMS) || die "frozen r1 changed"
[ "$(sha256sum < $A/SHA256SUMS | cut -c1-64)" = 409b8ed25a2f5096783c5a8d9acf3e330450d37265850d68d5c4f9a58160bc92 ] && (cd $A && sha256sum -c --quiet SHA256SUMS) || die "activation-r2 changed"
PT=$(mktemp -d /tmp/rlc-r2.XXXXXX) || die "mktemp"
export TMPDIR=$PT HOME=$PT PYTHONDONTWRITEBYTECODE=1
suite() {   # name dir expected module
  (cd "$2" && timeout -k 10 900 python3 -B - "$OUT/$1.json" "$3" "$4" > "$OUT/$1.txt" 2>&1 <<'PY'
import json, sys, unittest
out, expected, mod = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sys.path.insert(0, '.')
res = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromName(mod))
c = {'testsRun': res.testsRun, 'failures': len(res.failures), 'errors': len(res.errors), 'skipped': len(res.skipped),
     'expectedFailures': len(res.expectedFailures), 'unexpectedSuccesses': len(res.unexpectedSuccesses)}
ok = res.wasSuccessful() and c['testsRun'] == expected and not any(v for k, v in c.items() if k != 'testsRun')
json.dump({'module': mod, 'expected': expected, 'counts': c, 'pass': ok,
           'notPassed': [t.id() for t, _ in res.failures + res.errors + res.skipped]}, open(out, 'x'), indent=1)
sys.exit(0 if ok else 1)
PY
  ); local r=$?
  [ $r = 0 ] && echo "PASS $1: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["counts"])' "$OUT/$1.json")" || fail "$1 (rc $r; $OUT/$1.txt)"; }
# 2 frozen activation-r2 suite IN PLACE (it resolves WORK = HERE.parents[1]); read-only: -B, no bytecode, sums re-checked after
suite activation-r2-guard "$A" 15 test_retention_guard
# 3 the r2 controller harness
suite controller-r2 "$S/tests" 14 test_controller
(cd $S && sha256sum -c --quiet SHA256SUMS) || fail "r2 changed during the run"
(cd $A && sha256sum -c --quiet SHA256SUMS) || fail "activation-r2 changed during the run"
echo "## outputs: $OUT"; echo "## retention-controller-r2-offline rc=$rc"; exit $rc
