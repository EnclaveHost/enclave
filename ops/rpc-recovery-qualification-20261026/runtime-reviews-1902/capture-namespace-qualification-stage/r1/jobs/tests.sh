#!/bin/bash
# capture-namespace-qualification-stage/r1 PURE unit tests (PREPARED by Claude 1895; NOT run by Claude). Root (small lane):
#   bash jobs/q-exit-status.sh cnq-r1-unit 256 unshare -Urn bash capture-namespace-qualification-stage/r1/jobs/tests.sh
# tests/test_cnq.py: exactly "Ran 8 tests", last line OK, stdout empty, no ResourceWarning/skipped/FAIL/ERROR/Traceback. Pure: no namespace work.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
O=$S/runs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O" || exit 9
(cd "$O" && env -i PATH=$PATH timeout -k 5 300 python3 -I -B -u -W always::ResourceWarning "$S/tests/test_cnq.py") > "$O/out.txt" 2> "$O/err.txt"; r=$?
ok=1
[ $r = 0 ] && [ "$(grep -c '^Ran 8 tests' "$O/err.txt")" = 1 ] && [ "$(grep -v '^$' "$O/err.txt" | tail -1)" = OK ] && [ ! -s "$O/out.txt" ] \
  && ! grep -qE 'ResourceWarning|skipped|FAIL|ERROR|Traceback' "$O/err.txt" && ok=0
tail -3 "$O/err.txt"; echo "## outputs $O"; echo "## cnq-r1-unit rc=$ok"; exit $ok
