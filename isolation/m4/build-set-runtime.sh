#!/bin/sh
# Build the existing Enclave Wasmtime patch stack for CPU guests, without CUDA,
# NVENC or host GPU libraries. Never modifies an existing runtime/source tree.
# Usage: build-set-runtime.sh <new directory>
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
out=${1:?usage: build-set-runtime.sh <new directory>}
[ ! -e "$out" ] || { echo "output already exists: $out" >&2; exit 2; }
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)
ref=ac0772970b9ad2cd53866d95db69e26311fe3b75
git init -q "$out/src"
git -C "$out/src" fetch -q --depth 1 "${WASMTIME_SOURCE_REPO:-https://github.com/bytecodealliance/wasmtime}" "$ref"
git -C "$out/src" checkout -q --detach FETCH_HEAD
[ "$(git -C "$out/src" rev-parse HEAD)" = "$ref" ]
curl -fsSL --retry 3 https://static.crates.io/crates/wasmparser/wasmparser-0.254.0.crate -o "$out/wasmparser.crate"
printf '%s  %s\n' d5769a29f799fbab136aaf65b4fe5384cd7d93fe6fc9ba0dcb6c8382a1f16e27 "$out/wasmparser.crate" | sha256sum -c -
mkdir -p "$out/src/vendor/wasmparser"
tar -xzf "$out/wasmparser.crate" -C "$out/src/vendor/wasmparser" --strip-components=1
patch -s -p1 -d "$out/src/vendor/wasmparser" < "$repo/wasm/wasmparser-set-relax.patch"
# Same ordered patches as wasm/Dockerfile.wasmtime. Backend implementations stay
# feature-gated; only the CPU WASI interface is built below.
for p in onnx-gpu-strict vault-fs p2-host-header egress loopback nn-ggml nn-sdcpp nn-nvenc nn-onnx-preload nn-arbiter set-threads socket-level-check set-epochs shared-base-mirror shared-utf8-adapters; do
 git -C "$out/src" apply --check "$repo/wasm/wasmtime-$p.patch"
 git -C "$out/src" apply "$repo/wasm/wasmtime-$p.patch"
 sha256sum "$repo/wasm/wasmtime-$p.patch" >> "$out/patches.sha256"
done
(cd "$out/src" && cargo build --release -j "${RUNTIME_BUILD_JOBS:-4}" --no-default-features \
 --features run,serve,compile,wat,parallel-compilation,cache,cranelift,component-model,component-model-async,threads,wasi-http,wasi-nn --bin wasmtime)
mkdir "$out/bin"
cp "$out/src/target/release/wasmtime" "$out/bin/wasmtime"
"$here/probe-set.sh" "$out/bin/wasmtime"
"$here/probe-mem64.sh" "$out/bin/wasmtime"
sha256sum "$out/bin/wasmtime" > "$out/runtime.sha256"
rustc -Vv > "$out/rustc.txt"
printf 'Runtime ready: %s/bin/wasmtime\n' "$out"
