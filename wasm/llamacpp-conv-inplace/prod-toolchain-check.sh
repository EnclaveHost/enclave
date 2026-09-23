#!/bin/bash
# Inside ubuntu:22.04 (the llamacpp-toolchain runner's OS and stock compiler):
# the CPU part of the production configuration, then the conv harnesses.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq build-essential cmake git >/dev/null
gcc --version | head -1; cmake --version | head -1
mkdir -p /work && cp -a /src /work/llama-src
cmake -S /work/llama-src -B /work/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON \
  -DGGML_NATIVE=OFF -DCMAKE_C_FLAGS="-DGGML_MAX_NAME=128" -DCMAKE_CXX_FLAGS="-DGGML_MAX_NAME=128" \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TOOLS=OFF \
  -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_COMMON=OFF -DLLAMA_OPENSSL=OFF > /out/cmake.log 2>&1
cmake --build /work/build -j"$(nproc)" --target llama ggml-cpu > /out/build.log 2>&1
grep -m1 "CXX_FLAGS" /work/build/ggml/src/CMakeFiles/ggml-cpu.dir/flags.make > /out/cpu-flags.txt || true
ls /work/build/bin/ > /out/libs.txt
B=/work/build/bin; I="-I/work/llama-src/include -I/work/llama-src/ggml/include"
for t in conv-equiv conv-equiv2 conv-graph-test; do
  g++ -O2 -std=c++17 -DGGML_MAX_NAME=128 $I -o /work/$t /tests/$t.cpp -L$B -lllama -lggml -lggml-cpu -lggml-base -Wl,-rpath,$B
done
. /tests/harness-check.sh
run_equiv conv-equiv  "ALL IDENTICAL" /work/conv-equiv
run_equiv conv-equiv2 "ALL PASS"      /work/conv-equiv2
CONV_TEST_CPU_BACKEND=$B/libggml-cpu.so run_graph /work/conv-graph-test /model/m.gguf /out
echo "ALL CHECKS PASSED"
