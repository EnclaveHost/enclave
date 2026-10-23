#!/bin/bash
# Focused build + tests for the commitment mode only (no unchanged suites). target/ persists (incremental).
set -uo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=1 CARGO_TERM_COLOR=never
timeout -k 10 1740 bash -euo pipefail -c '
  step() { echo "=== $(date -u +%FT%TZ) $*"; }
  step toolchain; rustc --version
  step lock-diff; python3 -I tools/lock-diff.py upstream/base-5476069f/Cargo.lock Cargo.lock
  step build; cargo build -p enclave-base-head-listener --bin enclave-base-head-listener
  step test-commitment; cargo test -p enclave-base-head-listener --test commitment -- --test-threads=1
  step artifact; sha256sum target/debug/enclave-base-head-listener Cargo.lock
  step done
'
rc=$?; echo "=== $(date -u +%FT%TZ) exit rc=$rc"; exit $rc
