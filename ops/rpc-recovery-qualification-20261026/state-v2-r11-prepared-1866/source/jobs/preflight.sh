#!/bin/bash
# base-state-readonly-stage/r11 OFFLINE resolution preflight (PREPARED by Claude; NOT run by Claude). No compilation. r8: started ONLY as
#   bash jobs/q-exit-status.sh bsro-r11-preflight 4096 bash base-state-readonly-stage/r11/jobs/build-outer.sh preflight
# i.e. inside the same gated namespace and disk guard as the build (BSRO_RUN_DIR): metadata.json, lock check and toolchain notes land in the
# /vm run dir, not on root. Body = r7: pinned toolchain, `cargo metadata --offline`, Base-lock-only check, cache + rustup home unchanged.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
prepare preflight
(cd "$B/tree" && "${E[@]}" timeout -k 10 600 cargo metadata --offline --format-version 1 > "$O/metadata.json" 2> "$O/metadata.err"); rc=$?
[ $rc = 0 ] || { tail -20 "$O/metadata.err"; }
lock_check || { echo "## resolved lock differs from the Base lock"; rc=9; }
unchanged || rc=9
cat "$O/toolchain.txt" "$O/lock-check.json"; rm -rf "$B"
echo "## outputs $O"; echo "## bsro-r11-preflight rc=$rc"; exit $rc
