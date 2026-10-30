#!/bin/bash
# base-state-readonly-stage/r4 OFFLINE build of BOTH binaries (PREPARED by Claude; NOT run by Claude). Root, after preflight rc 0:
#   bash jobs/q-exit-status.sh bsro-r4-build 4096 unshare -Urn bash base-state-readonly-stage/r4/jobs/build.sh
# = r3 build (fresh CARGO_HOME over the cached store via symlinks, fresh target, seeded Base lock, --offline -j 4, 7200 s, Base-lock-only
# resolution, cache unchanged) + r4 pinned rustup env (jobs/env.sh). Binaries are copied 0555 to runs/build-*/.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
prepare build
(cd "$B/tree" && "${E[@]}" timeout -k 30 7200 cargo build --release --offline -j 4 --bins) > "$O/build.log" 2>&1; rc=$?
unchanged || rc=9
lock_check || { echo "## resolved lock differs from the Base lock"; rc=9; }
tail -5 "$O/build.log"; cat "$O/toolchain.txt" "$O/lock-check.json"
if [ $rc = 0 ] && [ -x "$B/target/release/base-state-readonly" ] && [ -x "$B/target/release/mk_fixture" ]; then
  for b in base-state-readonly mk_fixture; do cp "$B/target/release/$b" "$O/$b" && chmod 0555 "$O/$b"; done; sha256sum "$O/base-state-readonly" "$O/mk_fixture"
else
  [ $rc = 0 ] && rc=9
fi
echo "## scratch $B (remove after review)"; echo "## outputs $O"; echo "## bsro-r4-build rc=$rc"; exit $rc
