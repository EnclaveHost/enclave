#!/bin/bash
# rpc-priority: build the patched helios CLI only (r2: unit tests 6/6 passed and opstack-server built; r2's cargo line
# applied --bin opstack-server to both packages, so the CLI was not built). Same flags as r2.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
export CARGO_HOME=$W/cargo-home CARGO_TARGET_DIR=$W/helios-target CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 RUSTFLAGS="-C link-arg=-Wl,--threads=1"
cd $W/helios-patched
git log --oneline -1
timeout -k 10 3000 cargo build --locked --offline -p helios-cli --bin helios
sha256sum $CARGO_TARGET_DIR/debug/helios $CARGO_TARGET_DIR/debug/opstack-server
echo BUILD_OK
