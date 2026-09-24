#!/bin/bash
# Official-toolchain gate for the graph-slot multi-sequence reservation fix: the
# llamacpp-toolchain workflow's tree (LLAMA_COMMIT + its patches in workflow
# order, llamacpp-graph-slot.patch carrying the fix) built with the workflow's
# CPU flags inside ubuntu:22.04 (stock GCC 11.4), then graph-slot-check.sh: all
# conv-graph-test scenarios x {per-sequence, unified} KV, slot on vs
# LLAMA_GRAPH_SLOT_ALT=0, byte-identical logits required.
# Mounts: /src = the prepared official tree (read-only), /tests = this directory,
# /model/m.gguf = the 0.8B qwen35 model, /out = results.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq build-essential cmake git >/dev/null
gcc --version | head -1; cmake --version | head -1
mkdir -p /work && cp -a /src /work/llama-src
grep -q "n_seqs_rsv" /work/llama-src/src/llama-context.cpp || { echo "FAIL: the tree does not carry the graph-slot reservation fix"; exit 1; }
cmake -S /work/llama-src -B /work/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON \
  -DGGML_NATIVE=OFF -DCMAKE_C_FLAGS="-DGGML_MAX_NAME=128" -DCMAKE_CXX_FLAGS="-DGGML_MAX_NAME=128" \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TOOLS=OFF \
  -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_COMMON=OFF -DLLAMA_OPENSSL=OFF > /out/cmake.log 2>&1
cmake --build /work/build -j"$(nproc)" --target llama ggml-cpu > /out/build.log 2>&1
grep -m1 "CXX_FLAGS" /work/build/ggml/src/CMakeFiles/ggml-cpu.dir/flags.make > /out/cpu-flags.txt || true
B=/work/build/bin; I="-I/work/llama-src/include -I/work/llama-src/ggml/include"
g++ -O2 -std=c++17 -pthread -DGGML_MAX_NAME=128 $I -o /work/conv-graph-test /tests/conv-graph-test.cpp \
  -L$B -lllama -lggml -lggml-cpu -lggml-base -Wl,-rpath,$B
CONV_TEST_CPU_BACKEND=$B/libggml-cpu.so bash /tests/graph-slot-check.sh /work/conv-graph-test /model/m.gguf /out/matrix
echo "ALL CHECKS PASSED"
