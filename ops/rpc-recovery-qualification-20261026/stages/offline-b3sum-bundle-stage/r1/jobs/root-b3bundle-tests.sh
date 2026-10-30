#!/bin/bash
# root-b3bundle-tests.sh (offline-b3sum-bundle-stage/r1; PREPARED, never run by Claude). Root, host, offline, via the queue:
#   jobs/q-exit-status.sh root-b3bundle-tests 256 unshare -Urn bash offline-b3sum-bundle-stage/r1/jobs/root-b3bundle-tests.sh
# Verification-logic tests with tiny synthetic fixtures + mocked gpgv status (no network/gpgv/dpkg/package). NOT a qualification.
# PASS only if exactly 14 tests ran, the final line is a bare "OK" (no skips) and rc 0.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT=$S/logs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$OUT" || exit 9; rc=0
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "SETUP: stage != SHA256SUMS"; exit 9; }
python3 --version > "$OUT/env.txt" 2>&1
timeout -k 10 300 python3 -I "$S/test/test_b3bundle.py" > "$OUT/tests.txt" 2>&1 < /dev/null; r=$?
python3 -I - "$OUT/tests.txt" $r <<'PY' > "$OUT/summary.txt" || rc=1
import re, sys
t = open(sys.argv[1]).read(); r = int(sys.argv[2])
ran = re.findall(r'^Ran (\d+) tests? in', t, re.M); last = t.rstrip().splitlines()[-1] if t.strip() else ''
ok = r == 0 and ran == ['14'] and last == 'OK'
print(('PASS' if ok else 'FAIL') + f' b3bundle-logic (NOT a qualification) rc {r} ran {ran} final {last!r}')
sys.exit(0 if ok else 1)
PY
cat "$OUT/summary.txt"; echo "## outputs $OUT"; exit $rc
