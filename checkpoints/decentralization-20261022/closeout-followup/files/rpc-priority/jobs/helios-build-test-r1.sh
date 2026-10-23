#!/bin/bash
# rpc-priority: focused build + unit tests of patched Helios (branch enclave-base-compat). Debug profile (no fat LTO).
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
export CARGO_HOME=$W/cargo-home CARGO_TARGET_DIR=$W/helios-target CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0
cd $W/helios-patched
git log --oneline -1
echo "== unit tests (helios-opstack lib)"
timeout -k 10 4200 cargo test --locked --offline -p helios-opstack --lib -- --test-threads=1
echo "== build opstack-server + helios CLI"
timeout -k 10 3000 cargo build --locked --offline -p helios-opstack --bin opstack-server -p helios-cli
ls -la $CARGO_TARGET_DIR/debug/helios $CARGO_TARGET_DIR/debug/opstack-server
sha256sum $CARGO_TARGET_DIR/debug/helios $CARGO_TARGET_DIR/debug/opstack-server
echo BUILD_TEST_OK
