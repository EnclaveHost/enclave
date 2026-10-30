#!/bin/bash
# base-state-readonly-stage/r5 OFFLINE resolution preflight (PREPARED by Claude; NOT run by Claude). No compilation. Root:
#   bash jobs/q-exit-status.sh bsro-r5-preflight 256 unshare -Urn bash base-state-readonly-stage/r5/jobs/preflight.sh
# Pinned toolchain check, then `cargo metadata --offline` (resolves the seeded Base lock against the cached store; no network, no
# build) and the Base-lock-only check. The cached store and the rustup home must be unchanged. 600 s.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
prepare preflight
(cd "$B/tree" && "${E[@]}" timeout -k 10 600 cargo metadata --offline --format-version 1 > "$O/metadata.json" 2> "$O/metadata.err"); rc=$?
[ $rc = 0 ] || { tail -20 "$O/metadata.err"; }
lock_check || { echo "## resolved lock differs from the Base lock"; rc=9; }
unchanged || rc=9
cat "$O/toolchain.txt" "$O/lock-check.json"; rm -rf "$B"
echo "## outputs $O"; echo "## bsro-r5-preflight rc=$rc"; exit $rc
