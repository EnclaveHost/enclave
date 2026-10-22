#!/usr/bin/env bash
# Build the encrypted-volumes consumer component (immutable; v2) from the copied public source the way enclave-apps'
# README documents for every app (cargo build --release --target wasm32-wasip2), offline and locked; the committed
# src/bindings.rs is used as is. Asserts the artifact is a WebAssembly COMPONENT (preamble 00 61 73 6d 0d 00 01 00).
set -euo pipefail
cd "$(dirname "$0")/apps/encrypted-volumes"
sha256sum -c --quiet ../encrypted-volumes.SOURCE.sha256
export CARGO_TARGET_DIR="$(pwd)/target" CARGO_BUILD_JOBS=2
cargo build --release --target wasm32-wasip2 --offline --locked
a=target/wasm32-wasip2/release/encrypted_volumes.wasm
test "$(head -c 8 "$a" | od -An -tx1 | tr -d ' \n')" = 0061736d0d000100
ls -l "$a"; sha256sum "$a"
echo "build-app-v2: PASS"
