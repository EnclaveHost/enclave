#!/usr/bin/env bash
# Attempt 3. Attempts 1-2 compiled cleanly; the wasm linker crossed 1024 MiB loading the
# dependencies' DWARF (rust-lld 676-719 MiB + idle rustc). Same profile (opt-level 2),
# without debug info for any crate. Debug info does not change code behavior.
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/tree/enclavedns
export CARGO_TARGET_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/target CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0
exec cargo test --target wasm32-wasip2 --offline -j1 --no-run 2>&1
