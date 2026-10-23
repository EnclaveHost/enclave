#!/bin/bash
# repro-step.sh: provenance check. Removes ONLY the local crates' wasm32-wasip2 release outputs (sia-s3 and the vendored
# sia-sdk-rs crates; the Cargo.lock-pinned registry dependencies stay cached), then rebuilds with wasm-step.sh.
cd "$(dirname "$0")/sia-s3" || exit 2
export CARGO_TARGET_DIR="$(dirname "$PWD")/target"
cargo clean --offline --release --target wasm32-wasip2 -p sia-s3 -p sia_storage -p sia_core -p sia_core_derive -p sia_mux -p reqwest_wasi 2>&1 | tail -2
exec ../wasm-step.sh
