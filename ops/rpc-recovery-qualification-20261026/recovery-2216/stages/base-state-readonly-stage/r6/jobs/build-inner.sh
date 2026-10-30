#!/bin/bash
# base-state-readonly-stage/r6 build BODY: run ONLY by jobs/build.sh through jobs/disk_guard.py (BSRO_RUN_DIR = the guard run dir).
# = r3 build (fresh CARGO_HOME over the cached store via symlinks, fresh target, seeded Base lock, --offline -j 4, 7200 s, Base-lock-only
# resolution, cache unchanged) + r4 pinned rustup env (jobs/env.sh). Binaries are copied 0555 to runs/build-*/.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
[ -n "${BSRO_RUN_DIR:-}" ] || die "must run under jobs/disk_guard.py (no BSRO_RUN_DIR)"
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
echo "## scratch $B (kept for review)"; echo "## outputs $O"; echo "## bsro-r6-build-inner rc=$rc"; exit $rc
