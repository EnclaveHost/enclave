#!/usr/bin/env bash
# (1) the probe module's unit tests, standalone (no dependencies); (2) the patched crate type-checks for its real target
# (wasm32-wasip2), offline, one job. Through the queue (512).
set -u
cd "$(dirname "$0")"; LOG=${1:?log}; exec > "$LOG" 2>&1
mkdir -p .build
rustc --version
rustc --edition 2021 --test s3-ipfs-adapter/src/probe.rs -o .build/probe-tests && ./.build/probe-tests; a=$?
( cd s3-ipfs-adapter && CARGO_TARGET_DIR=../.build/target cargo check --offline --target wasm32-wasip2 -j1 2>&1 | tail -25 ); b=${PIPESTATUS[0]}
b=$(cd s3-ipfs-adapter && CARGO_TARGET_DIR=../.build/target cargo check --offline --target wasm32-wasip2 -j1 >/dev/null 2>&1; echo $?)
echo "=== EXIT probe-tests=$a cargo-check=$b"; [ $a -eq 0 ] && [ $b -eq 0 ]
