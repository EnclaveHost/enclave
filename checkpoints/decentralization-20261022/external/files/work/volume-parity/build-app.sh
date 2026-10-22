#!/usr/bin/env bash
# Build the encrypted-volumes consumer component from the copied public source (offline, locked), as test/encvol-e2e.py expects.
set -euo pipefail
cd "$(dirname "$0")/apps/encrypted-volumes"
export CARGO_TARGET_DIR="$(pwd)/target"
cargo component build --release --target wasm32-wasip1 --offline --locked
ls -l target/wasm32-wasip1/release/encrypted_volumes.wasm
sha256sum target/wasm32-wasip1/release/encrypted_volumes.wasm
