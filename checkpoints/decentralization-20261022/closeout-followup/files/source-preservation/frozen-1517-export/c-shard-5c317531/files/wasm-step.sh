#!/bin/bash
# wasm-step.sh: release build of the candidate for wasm32-wasip2 (the deploy artifact target), offline, one job,
# isolated target dir. storage-shard-recovery copy of storage-clone-privacy-review/candidate/wasm-step.sh. Prints the artifact's size and sha256. Fails if cargo fails OR the artifact
# is missing or is not a WebAssembly component (it never reports a build it cannot show).
cd "$(dirname "$0")/sia-s3" || exit 2
export CARGO_TARGET_DIR="$(dirname "$PWD")/target" CARGO_BUILD_JOBS=1
cargo build --offline --release --target wasm32-wasip2 > ../logs/wasm-last.out 2>&1
rc=$?
grep -E "^error|^warning: unused|Finished" ../logs/wasm-last.out | head -20
echo "cargo exit=$rc"
[ $rc -eq 0 ] || exit $rc
f="$CARGO_TARGET_DIR/wasm32-wasip2/release/sia-s3.wasm"
[ -f "$f" ] || { echo "ARTIFACT MISSING: $f"; exit 4; }
[ "$(od -A n -t x1 -N 8 "$f" | tr -d ' ')" = "0061736d0d000100" ] || { echo "NOT A WASM COMPONENT: $f"; exit 5; }
ls -l "$f"
sha256sum "$f"
