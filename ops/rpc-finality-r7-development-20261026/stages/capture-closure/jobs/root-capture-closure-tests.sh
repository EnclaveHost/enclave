#!/bin/bash
# production-capture-closure-stage: root's offline job (PREPARED; NOT run by Claude). Unit tests of the guest runtime policy, settings,
# templates and the closure manifest: exactly 14, no skip.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh capture-closure-1 512 unshare -rn bash production-capture-closure-stage/jobs/root-capture-closure-tests.sh
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/production-capture-closure-stage; OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
mkdir -p "$OUT/tmp" || exit 1
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## INVALID: stage differs from SHA256SUMS"; echo "## capture-closure rc=1"; exit 1; }
(cd "$S" && env -i PATH=/usr/bin:/bin TMPDIR="$OUT/tmp" HOME="$OUT/tmp" timeout 600 /usr/bin/python3 -I -B tests/test_capture_closure.py < /dev/null) > "$OUT/tests.txt" 2>&1; t=$?
if [ $t = 0 ] && grep -q '^Ran 14 tests in ' "$OUT/tests.txt" && [ "$(tail -n 1 "$OUT/tests.txt")" = OK ] && ! grep -qiE 'skipped|expected failure|unexpected success' "$OUT/tests.txt"; then echo "PASS closure: 14"; else echo "FAIL closure: rc $t, $(grep -m1 '^Ran ' "$OUT/tests.txt"), last $(tail -n1 "$OUT/tests.txt")"; rc=1; fi
echo "## outputs: $OUT"; echo "## capture-closure SHA256SUMS $(sha256sum < "$S/SHA256SUMS" | cut -c1-64)"; echo "## capture-closure rc=$rc"; exit $rc
