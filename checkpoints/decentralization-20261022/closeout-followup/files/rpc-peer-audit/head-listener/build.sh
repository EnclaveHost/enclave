#!/bin/bash
# One queued build job: resolve, fetch, compile, test. target/ persists between runs.
set -uo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=1 CARGO_TERM_COLOR=never
step() { echo "=== $(date -u +%FT%TZ) $*"; }
timeout -k 10 1740 bash -euo pipefail -c '
  step() { echo "=== $(date -u +%FT%TZ) $*"; }
  step toolchain; rustc --version; cargo --version
  step metadata; cargo metadata --format-version 1 > /dev/null
  step lock-diff; python3 -I tools/lock-diff.py upstream/base-5476069f/Cargo.lock Cargo.lock
  step fetch; cargo fetch
  step test-build; cargo test -p enclave-base-head-listener --no-run
  step bin-build; cargo build -p enclave-base-head-listener --bin enclave-base-head-listener
  step test-run; cargo test -p enclave-base-head-listener -- --test-threads=1
  step artifact; sha256sum target/debug/enclave-base-head-listener Cargo.lock
  step done
'
rc=$?
step "exit rc=$rc"
exit $rc
