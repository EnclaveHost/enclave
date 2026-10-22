#!/usr/bin/env bash
# The preload end-to-end's app (immutable; v1): enclave-apps/ggml-probe (a wasi:http component built on load_by_name),
# copied once into cache/ggml-probe-src with its file hashes pinned, built offline for wasm32-wasip2 (the documented
# component build). Output: cache/ggml-probe.wasm and its sha256.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave-apps/ggml-probe
c="$here/cache/ggml-probe-src"
if [ ! -d "$c" ]; then
  mkdir -p "$c"; cp -R "$src/Cargo.toml" "$src/Cargo.lock" "$src/src" "$src/wit" "$c/"
  (cd "$c" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$here/cache/ggml-probe-src.sha256"
fi
(cd "$c" && sha256sum -c --quiet "$here/cache/ggml-probe-src.sha256")
export CARGO_TARGET_DIR="$here/cache/ggml-probe-target" CARGO_BUILD_JOBS=2
(cd "$c" && cargo build --offline --locked --release --target wasm32-wasip2)
cp "$CARGO_TARGET_DIR/wasm32-wasip2/release/ggml_probe.wasm" "$here/cache/ggml-probe.wasm"
head -c 8 "$here/cache/ggml-probe.wasm" | od -An -tx1 | tr -d ' \n' | grep -q '^0061736d0d000100$' || { echo "not a component"; exit 1; }
sha256sum "$here/cache/ggml-probe.wasm"
echo "build-ggml-probe-v1: PASS"
