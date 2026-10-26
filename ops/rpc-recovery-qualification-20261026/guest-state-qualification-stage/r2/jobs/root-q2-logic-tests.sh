#!/bin/bash
# root-q2-logic-tests.sh (guest-state-qualification-stage/r2; PREPARED, never run by Claude). Root, host or guest, offline, via the queue:
#   jobs/q-exit-status.sh root-gsq-r2-logic 256 bash guest-state-qualification-stage/r2/jobs/root-q2-logic-tests.sh
# MOCKED decision-logic tests of q2 (systemd/base/zstd/sha256 mocked). NOT a native qualification. PASS only if exactly 19 tests ran,
# the final line is a bare "OK" (no skips) and rc 0. Writes only a temp dir (removed) and logs under the stage.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT=$S/logs/logic-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$OUT" || exit 9; rc=0
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "SETUP: stage != SHA256SUMS"; exit 9; }
python3 --version > "$OUT/env.txt" 2>&1
timeout -k 10 300 python3 -I "$S/test/test_q2_logic.py" > "$OUT/tests.txt" 2>&1 < /dev/null; r=$?
python3 -I - "$OUT/tests.txt" $r <<'PY' > "$OUT/summary.txt" || rc=1
import re, sys
t = open(sys.argv[1]).read(); r = int(sys.argv[2])
ran = re.findall(r'^Ran (\d+) tests? in', t, re.M); last = t.rstrip().splitlines()[-1] if t.strip() else ''
ok = r == 0 and ran == ['19'] and last == 'OK'
print(('PASS' if ok else 'FAIL') + f' q2-logic (NOT native qualification) rc {r} ran {ran} final {last!r}')
sys.exit(0 if ok else 1)
PY
cat "$OUT/summary.txt"; echo "## outputs $OUT"; exit $rc
