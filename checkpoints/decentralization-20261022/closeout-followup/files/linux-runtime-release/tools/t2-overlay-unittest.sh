#!/usr/bin/env bash
# t2 (queue 256): the overlay tool's own unittest (test/metal-control-overlay.test.py, run as a script: unittest.main) in the
# t1 throwaway clone of the composed commit. t1's G4-overlay-unittest invoked it as `python3 -m unittest test/<file>.py`,
# which cannot import a hyphenated module name (ImportError before any case ran): that was a harness error, not a result.
set -euo pipefail
. "$(dirname "$0")/env.sh"
X=$B/tmp/tree; C=fec43a6a08da2ac287fb3a5c42de89f096f4f678
[ "$(git -C "$X" rev-parse HEAD)" = "$C" ] || { echo "tree HEAD is not $C"; exit 4; }
cmp -s <(git -C "$X" show "$C:metal/overlay-control-image.py") "$X/metal/overlay-control-image.py" || { echo "overlay tool differs from the commit"; exit 4; }
cmp -s <(git -C "$X" show "$C:test/metal-control-overlay.test.py") "$X/test/metal-control-overlay.test.py" || { echo "test differs from the commit"; exit 4; }
cd "$X"; set +e; timeout -k 5 280 python3 -u test/metal-control-overlay.test.py -v; rc=$?; set -e
rm -rf "$X/metal/__pycache__" "$X/test/__pycache__"
echo "[t2] overlay unittest exit=$rc"; echo "$rc" > "$B/receipts/t2-overlay-unittest.rc"
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); [ "$n" -eq 0 ] || { echo "stub invoked $n times"; exit 5; }
exit $rc
