#!/bin/bash
# Unit fixtures of jobs/root-multipart-batches-1773.py (PREPARED by Claude 1773; NOT run by Claude). Root, via the shared queue:
#   bash jobs/q-exit-status.sh rmp-batches-1779-tests 256 unshare -Urn bash jobs/root-multipart-batches-1773-tests.sh
# Tiny synthetic dirs under a NEW run dir only; no original, session, wrapper or queue child. PASS = exactly "Ran 14 tests", last
# line OK, stdout empty, no ResourceWarning/skipped/FAIL/ERROR/Traceback.
set -uo pipefail
export PATH=/usr/bin:/bin
read -r _in outer _n < /proc/self/uid_map
[ "$outer" != 0 ] || { echo "REFUSED: run as the unprivileged owner under unshare -Urn"; exit 9; }
J=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P); P=$(cd "$J/.." && pwd -P)
O=$P/logs/rmp-batches-1779-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -m 0700 "$O" && mkdir -m 0700 "$O/tmp" || exit 9
sha256sum "$J/root-multipart-batches-1773.py" "$J/test_root_multipart_batches_1779.py" > "$O/inputs.sha256"
(cd "$O" && env -i PATH=$PATH MULTIPART_BATCH_TEST_TMP="$O/tmp" timeout -k 5 600 python3 -I -B -u -W always::ResourceWarning "$J/test_root_multipart_batches_1779.py") > "$O/stdout.txt" 2> "$O/stderr.txt"; r=$?
tail -3 "$O/stderr.txt"
ok=1; [ $r = 0 ] || ok=0; [ "$(grep -c '^Ran 14 tests in ' "$O/stderr.txt")" = 1 ] || ok=0; [ "$(grep -v '^\s*$' "$O/stderr.txt" | tail -1)" = OK ] || ok=0
[ ! -s "$O/stdout.txt" ] || ok=0; grep -qE 'ResourceWarning|skipped|FAIL|ERROR|Traceback' "$O/stderr.txt" "$O/stdout.txt" && ok=0
rm -rf "$O/tmp"
[ $ok = 1 ] && { echo "## PASS (14)"; echo "## outputs $O"; exit 0; } || { echo "## FAIL (rc $r)"; echo "## outputs $O"; exit 1; }
