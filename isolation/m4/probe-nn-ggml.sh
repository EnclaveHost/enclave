#!/bin/sh
# Prove the runtime PRELOADS a ggml graph and serves it by name on the CPU backend (the shared runtime's model-volume
# preloads: wasm/wasm_manager.py stages a dir per volume; isolation/m2/modelvol.h does the same in a measured guest).
# A real execution: a tiny generated GGUF (tiny-gguf.py) preloaded with -S nn-graph=ggml::<dir>, then nn-probe.wat
# finds it by name and creates a context. A help listing alone is insufficient. No native cache or precompiled input.
#   probe-nn-ggml.sh <rtdir>   (rtdir holds ld-linux-x86-64.so.2, wasmtime, its libraries and backends/libggml-cpu.so)
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
rt=${1:?usage: probe-nn-ggml.sh <rtdir>}
[ -r "$rt/backends/libggml-cpu.so" ] || exit 1
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/probe"
python3 "$here/tiny-gguf.py" "$t/probe/model.gguf" --vocab 512 > /dev/null
result=$(ENCLAVE_GGML_BACKEND_DIR="$rt/backends" ENCLAVE_GGML_N_GPU_LAYERS=0 ENCLAVE_NN_SERVE_BYTES=1073741824 ENCLAVE_NN_SERVE_KIND=RAM \
  timeout 60 "$rt/ld-linux-x86-64.so.2" --library-path "$rt" "$rt/wasmtime" run -C cache=n -S nn -S "nn-graph=ggml::$t/probe" \
  --invoke run "$here/nn-probe.wat" 2>/dev/null) || exit 1   # a core module: its export by name (WAVE syntax is for components)
[ "$result" = 7 ] || exit 1
printf '1\n'
