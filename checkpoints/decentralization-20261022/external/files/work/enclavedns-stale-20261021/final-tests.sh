#!/usr/bin/env bash
# Final: rebuild the FIXED tree's test component (final crate only; the mutant overwrote the same path), run all tests.
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/tree/enclavedns
export CARGO_TARGET_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/target CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0
cargo test --target wasm32-wasip2 --offline -j1 --no-run > /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/build-tests.out 2>&1 || { cat /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/build-tests.out; exit 1; }
tail -2 /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/build-tests.out
exec /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/run-tests.sh
