#!/bin/bash
# Inside ubuntu:22.04 (the llamacpp-toolchain runner's OS and stock compiler):
# the CPU part of the production configuration, then the conv harnesses and the
# register-row and streaming-snapshot GATED_DELTA_NET checks
# (llamacpp-gdn-regrow.patch, llamacpp-gdn-ntsnap.patch).
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
for t in conv-equiv conv-equiv2 conv-graph-test gdn-equiv gdn-bench; do
  g++ -O2 -std=c++17 -pthread -DGGML_MAX_NAME=128 $I -o /work/$t /tests/$t.cpp -L$B -lllama -lggml -lggml-cpu -lggml-base -Wl,-rpath,$B
done
. /tests/harness-check.sh
run_equiv conv-equiv  "ALL IDENTICAL" /work/conv-equiv
run_equiv conv-equiv2 "ALL PASS"      /work/conv-equiv2
CONV_TEST_CPU_BACKEND=$B/libggml-cpu.so run_graph /work/conv-graph-test /model/m.gguf /out
run_pair gdn-equiv /work/gdn-equiv ENCLAVE_GGML_GDN_REGROW /out
mkdir -p /out/regrow && CONV_TEST_CPU_BACKEND=$B/libggml-cpu.so run_graph /work/conv-graph-test /model/m.gguf /out/regrow ENCLAVE_GGML_GDN_REGROW
mkdir -p /out/ntsnap && run_pair gdn-equiv /work/gdn-equiv ENCLAVE_GGML_GDN_NTSNAP /out/ntsnap
mkdir -p /out/ntsnap-graph && CONV_TEST_CPU_BACKEND=$B/libggml-cpu.so run_graph /work/conv-graph-test /model/m.gguf /out/ntsnap-graph ENCLAVE_GGML_GDN_NTSNAP
# informational, not a gate: the register row must be LIVE on this ISA, which
# the equality checks cannot show (both arms equal if the path compiled out)
for v in 1 0 1 0; do ENCLAVE_GGML_GDN_REGROW=$v /work/gdn-bench 2 8 2000; done | tee /out/gdn-bench.txt
echo "ALL CHECKS PASSED"
