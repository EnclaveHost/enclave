#!/bin/bash
# rpc-priority: patched Helios branch enclave-base-evm (Base EVM backend from base/base v1.5.1) - opstack unit tests
# (incl. base_backend) + helios CLI + opstack-server. Rust 1.96.0 is base/base's required toolchain (already installed;
# RUSTUP_TOOLCHAIN overrides helios's 1.94.0 pin, nothing is installed). Offline, 1 job, no debuginfo.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0
export CARGO_HOME=$W/cargo-home CARGO_TARGET_DIR=$W/helios-target-base CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 RUSTFLAGS="-C link-arg=-Wl,--threads=1"
rustc --version
cd $W/helios-patched
git log --oneline -1; git status --short
echo "== unit tests (helios-opstack lib)"
timeout -k 10 4800 cargo test --offline -p helios-opstack --lib -- --test-threads=1
echo "== build helios CLI"
timeout -k 10 2400 cargo build --offline -p helios-cli --bin helios
echo "== build opstack-server"
timeout -k 10 1200 cargo build --offline -p helios-opstack --bin opstack-server
sha256sum $CARGO_TARGET_DIR/debug/helios $CARGO_TARGET_DIR/debug/opstack-server
echo BUILD_TEST_OK
