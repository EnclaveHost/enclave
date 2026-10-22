#!/usr/bin/env bash
# Corrected 0.1.5 (tree-r2: review R1+R2) — root-approved single release build after the 45/45 pass.
# The crate's release pipeline (README "Build and test"): cargo build --release --target wasm32-wasip2.
# Profile from Cargo.toml unchanged (opt 3, lto=true, codegen-units=1, strip, panic=abort). Offline, locked, one job.
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/src-tree/enclavedns
export CARGO_TARGET_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5/target   # reuse the release deps built for the obsolete build
cargo build --release --target wasm32-wasip2 --offline --locked -j1 2>&1 || exit $?
f=$CARGO_TARGET_DIR/wasm32-wasip2/release/enclavedns.wasm
ls -l $f; sha256sum $f
