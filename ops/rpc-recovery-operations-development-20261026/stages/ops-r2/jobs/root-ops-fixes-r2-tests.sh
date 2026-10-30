#!/bin/bash
# base-finality-proof-stage/r6-ops-fixes-r2: root's offline job (PREPARED; NOT run by Claude). Runs ONLY the readiness/installer work:
#   ops readiness 25, ops installer 13 (r1 8 + r2 tree 5), and the r6 sampler suite 92 against the patched sampler (startTime added). Exact counts, no skip.
#   P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   cd $P && ./jobs/q-exit-status.sh finality-ops-fixes-r2-1 512 unshare -rn bash base-finality-proof-stage/r6-ops-fixes-r2/jobs/root-ops-fixes-r2-tests.sh
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/base-finality-proof-stage/r6-ops-fixes-r2; T=$S/tree; OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## INVALID: $*"; echo "## finality-ops-fixes-r2 rc=1"; exit 1; }
mkdir -p "$OUT/tmp" || die "out"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$T" && sha256sum -c --quiet SHA256SUMS) || die "tree files differ from the tree SHA256SUMS"
check() { # name expected-count rc file
  if [ "$3" = 0 ] && grep -q "^Ran $2 tests in " "$4" && [ "$(tail -n 1 "$4")" = OK ] && ! grep -qiE "skipped|expected failure|unexpected success" "$4"; then
    echo "PASS $1: $2"; else echo "FAIL $1: rc $3, $(grep -m1 '^Ran ' "$4" || echo 'no Ran line'), last $(tail -n 1 "$4")"; rc=1; fi; }
E="env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp"
(cd "$T" && $E timeout 600 /usr/bin/python3 -I -B tests/test_ops_readiness.py < /dev/null) > "$OUT/readiness.txt" 2>&1; check ops-readiness 25 $? "$OUT/readiness.txt"
(cd "$T" && $E timeout 600 /usr/bin/python3 -I -B tests/test_ops_installer.py < /dev/null) > "$OUT/installer.txt" 2>&1; check ops-installer 13 $? "$OUT/installer.txt"
SR=$OUT/sampler; mkdir -p "$SR/readiness" "$SR/coverage" && cp "$T"/readiness/*.py "$SR/readiness/" && cp "$P/coverage-stage/origin_extract.py" "$SR/coverage/" || die "sampler layout"
(cd "$SR/readiness" && $E timeout 1200 /usr/bin/python3 -I -B test_readiness_sampler.py < /dev/null) > "$OUT/sampler.txt" 2>&1; check sampler 92 $? "$OUT/sampler.txt"
echo "## outputs: $OUT"; echo "## r6-ops-fixes-r2 SHA256SUMS $(sha256sum < "$S/SHA256SUMS" | cut -c1-64)"; echo "## finality-ops-fixes-r2 rc=$rc"; exit $rc
