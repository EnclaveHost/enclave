#!/usr/bin/env bash
# EXPLORATION (immutable; v1): how the pinned nn-capable runtime reports a ggml preload, under `run` and `serve`, so the
# capability probe keys on the real behaviour. CPU backend only. Fixture model from isolation/m4/tiny-gguf.py.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rt="$here/cache/shield-rt-b9be6a09"
(cd "$rt" && sha256sum -c --quiet ../shield-rt-b9be6a09.sha256) || exit 1
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/graph/tiny" "$t/backends"
python3 "$here/tree/isolation/m4/tiny-gguf.py" "$t/graph/tiny/model.gguf" --vocab 512
cp "$rt/backends/libggml-cpu.so" "$t/backends/"
printf '(module (func (export "_start")))\n' > "$t/m.wat"
W="$rt/ld-linux-x86-64.so.2 --library-path $rt $rt/wasmtime"
echo "== run, info log"
ENCLAVE_GGML_BACKEND_DIR="$t/backends" ENCLAVE_GGML_N_GPU_LAYERS=0 WASMTIME_LOG=wasmtime_wasi_nn=info timeout 60 $W run -C cache=n -S nn -S "nn-graph=ggml::$t/graph/tiny" "$t/m.wat" 2>&1 | tail -15; echo "rc=$?"
echo "== serve, info log"
app="$here/../volume-parity/apps/encrypted-volumes/target/wasm32-wasip2/release/encrypted_volumes.wasm"
( ENCLAVE_GGML_BACKEND_DIR="$t/backends" ENCLAVE_GGML_N_GPU_LAYERS=0 WASMTIME_LOG=wasmtime_wasi_nn=info timeout 25 $W serve -C cache=n -S cli -S nn -S "nn-graph=ggml::$t/graph/tiny" --addr 127.0.0.1:0 "$app" > "$t/serve.log" 2>&1 ) ; echo "rc=$?"
tail -20 "$t/serve.log"
echo "== serve, no log env"
( ENCLAVE_GGML_BACKEND_DIR="$t/backends" ENCLAVE_GGML_N_GPU_LAYERS=0 timeout 20 $W serve -C cache=n -S cli -S nn -S "nn-graph=ggml::$t/graph/tiny" --addr 127.0.0.1:0 "$app" > "$t/serve2.log" 2>&1 ) ; echo "rc=$?"
tail -10 "$t/serve2.log"
echo "== -S help"
$W run -S help 2>&1 | grep -i -A3 "nn" | head -20
echo "explore-nn-v1: DONE"
