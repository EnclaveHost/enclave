#!/usr/bin/env bash
# One queued Rust job (1024 MiB): native unit tests of the patched provider (incl. the walk over 9d's real export), then
# the wasm32-wasip2 check of the patched crate. Offline, -j1.
set -uo pipefail
cd "$(dirname "$0")/ipns-publisher"
export CARGO_TARGET_DIR="$(dirname "$PWD")/target"
export SITE_BLOCKS=/home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/content/export/ipfs
export SITE_ROOT=bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou
cargo test --offline -j1 2>&1 | grep -E "^test |test result|panicked|FAILED|left|right|warning: unused|^error" | tail -80; t=${PIPESTATUS[0]}
cargo check --offline -j1 --target wasm32-wasip2 2>&1 | tail -15; c=${PIPESTATUS[0]}
echo "test-rc=$t check-rc=$c"
