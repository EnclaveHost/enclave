#!/bin/bash
# root-srr3-tests.sh (resumable-state-recovery-stage/r3; PREPARED, never run by Claude). ROOT runs it on the HOST, foreground, via the queue:
#   SRR3_TEST_ROOT=/mnt/usb/enclave-rpc-production/srr3-test \
#   jobs/q-exit-status.sh root-srr3-tests-<n> 1024 bash resumable-state-recovery-stage/r3/jobs/root-srr3-tests.sh
# SRR3_TEST_ROOT: an existing 0700 directory owned by the running uid ON THE TARGET ntfs3 FILESYSTEM (same st_dev as the production work
# dir's parent), so pwrite/fsync/rename/flock/mode semantics are production's. HOME is NOT overridden. Only loopback HTTP is contacted.
# PASS only if exactly 30 tests ran, the final line is a bare "OK" (no skips) and rc 0. CURL=/path re-runs with another curl binary.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT=$S/logs/tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "SETUP-FAIL $*" > "$OUT/RESULT" 2>/dev/null; echo "## srr3-tests rc=9"; exit 9; }
mkdir -p "$OUT" || exit 9
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
R=${SRR3_TEST_ROOT:-}; [ -n "$R" ] && [ -d "$R" ] && [ ! -L "$R" ] || die "SRR3_TEST_ROOT must be an existing real directory"
[ "$(stat -c '%u %a' "$R")" = "$(id -u) 700" ] || die "SRR3_TEST_ROOT must be owned by $(id -u) with mode 700"
[ "$(stat -c %d "$R")" = "$(stat -c %d /mnt/usb/enclave-rpc-production)" ] || die "SRR3_TEST_ROOT is not on the target filesystem"
CURL=${CURL:-/usr/bin/curl}; [ -x "$CURL" ] || die "curl missing"
{ "$CURL" -V | head -1; python3 --version; findmnt -no SOURCE,FSTYPE,OPTIONS -T "$R"; id -u; sha256sum < "$S/SHA256SUMS"; } > "$OUT/env.txt" 2>&1
SRR3_TEST_ROOT=$R SRR3_CURL=$CURL timeout -k 10 1500 python3 -I "$S/test/test_srr3.py" > "$OUT/tests.txt" 2>&1 < /dev/null; r=$?
python3 -I - "$OUT/tests.txt" $r <<'PY' > "$OUT/summary.txt" || rc=1
import re, sys
t = open(sys.argv[1]).read(); r = int(sys.argv[2])
ran = re.findall(r'^Ran (\d+) tests? in', t, re.M); last = t.rstrip().splitlines()[-1] if t.strip() else ''
ok = r == 0 and ran == ['30'] and last == 'OK'
print(('PASS' if ok else 'FAIL') + f' srr3 rc {r} expected 30 ran {ran} final {last!r}')
sys.exit(0 if ok else 1)
PY
cat "$OUT/summary.txt"; cp "$OUT/summary.txt" "$OUT/RESULT"
leftover=$(find "$R" -mindepth 1 -maxdepth 1 -name 'srr3-*' | wc -l); echo "test dirs left in $R: $leftover" | tee -a "$OUT/summary.txt"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## FAIL: stage changed during the run"; rc=1; }
echo "## outputs $OUT"; echo "## srr3-tests rc=$rc"; exit $rc
