#!/usr/bin/env bash
# comment-only main.rs change: rebuild the release wasm (offline, -j1) and require byte-identical output
set -uo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target"
( cd ipns-publisher && cargo build --offline -j1 --release --target wasm32-wasip2 2>&1 | tail -2 ); b=${PIPESTATUS[0]}
sha256sum target/wasm32-wasip2/release/ipns-publisher.wasm ipns-publisher-ensrepair.wasm
cmp target/wasm32-wasip2/release/ipns-publisher.wasm ipns-publisher-ensrepair.wasm && echo IDENTICAL; c=$?
echo "build-rc=$b cmp-rc=$c"; [ $b -eq 0 ] && [ $c -eq 0 ]
