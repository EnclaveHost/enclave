#!/usr/bin/env bash
# Test the BUILT package (dist/site_host.wasm from scripts/build.sh) against the release directory it embeds.
#
#   scripts/test.sh <release dir>/<CID> [--native]
#
# - The end-to-end run (test/e2e.mjs) is real `wasmtime serve` with the wasm manager's serve-mode flags, inside a
#   network namespace that has loopback only.
# - WASMTIME selects the engine. Use the fleet engine for a compatibility verdict: the wasmtime binary of the image
#   pinned in the enclave repo's wasm/Dockerfile.wasm, with LD_LIBRARY_PATH for its libraries.
# - --native also runs the Rust tests (tests/site.rs) on the host.
set -euo pipefail
cd "$(dirname "$0")/.."
REL="$(realpath "${1:?usage: test.sh <release dir> [--native]}")"
test -s dist/site_host.wasm
if [ "${2:-}" = "--native" ]; then
  cargo test --locked --lib --tests
fi
echo "engine: $(${WASMTIME:-wasmtime} --version)"
unshare -rn sh -c "ip link set lo up && SITE_HOST_NETNS=1 SITE_HOST_WASM='$PWD/dist/site_host.wasm' SITE_RELEASE_DIR='$REL' node --test --test-concurrency=1 test/e2e.mjs"
echo "SITE-HOST-TEST-OK"
