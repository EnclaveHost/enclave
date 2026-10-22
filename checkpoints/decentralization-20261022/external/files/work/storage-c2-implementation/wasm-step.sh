#!/bin/bash
# wasm-step.sh: release build of the candidate for wasm32-wasip2 (the deploy artifact target), offline, one job,
# isolated target dir. Prints the artifact's size and sha256.
cd "$(dirname "$0")/sia-s3" || exit 2
export CARGO_TARGET_DIR="$(dirname "$PWD")/target" CARGO_BUILD_JOBS=1
cargo build --offline --release --target wasm32-wasip2 > ../logs/wasm-last.out 2>&1
rc=$?
grep -E "^error|^warning: unused|Finished" ../logs/wasm-last.out | head -20
f=target/wasm32-wasip2/release/sia-s3.wasm
[ $rc -eq 0 ] && ls -l "$f" && sha256sum "$f"
echo "cargo exit=$rc"
exit $rc
