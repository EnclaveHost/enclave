#!/bin/bash
# The official-path gate for a CPU-kernel candidate: the llama.cpp tree as the
# llamacpp-toolchain workflow builds it (LLAMA_COMMIT + its patches in workflow
# order) PLUS the candidate, here llamacpp-gdn-ntsnap.patch. Used 2026-09-23:
# ntsnap passed every check below and was then EXCLUDED by the 27B round timing
# (REPORT 18.54). Built with the workflow's CPU flags inside
# ubuntu:22.04 (the runner's OS, stock GCC 11.4), then:
#   1. gdn-equiv with ENCLAVE_GGML_GDN_NTSNAP=1 vs =0: byte-identical dumps
#      (outputs and every snapshot slot)
#   2. the 0.8B real graph (speculative rollback scenario) on vs off: identical logits
#   3. cold-state timing of the recurrent op at the 27B verify shape (48 rotating
#      per-layer states, 2 tokens, K = 2), NTSNAP on/off in ABBA order, with the
#      no-snapshot K = 1 control, informational
# Mounts: /src = the prepared official tree (read-only), /tests = this directory,
# /model/m.gguf = the 0.8B qwen35 model, /out = results.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq build-essential cmake git >/dev/null
gcc --version | head -1; cmake --version | head -1
mkdir -p /work && cp -a /src /work/llama-src
grep -q "gdn_copy_snapshot" /work/llama-src/ggml/src/ggml-cpu/ops.cpp || { echo "FAIL: the tree does not carry llamacpp-gdn-ntsnap.patch"; exit 1; }
cmake -S /work/llama-src -B /work/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON \
  -DGGML_NATIVE=OFF -DCMAKE_C_FLAGS="-DGGML_MAX_NAME=128" -DCMAKE_CXX_FLAGS="-DGGML_MAX_NAME=128" \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TOOLS=OFF \
  -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_COMMON=OFF -DLLAMA_OPENSSL=OFF > /out/cmake.log 2>&1
cmake --build /work/build -j"$(nproc)" --target llama ggml-cpu > /out/build.log 2>&1
grep -m1 "CXX_FLAGS" /work/build/ggml/src/CMakeFiles/ggml-cpu.dir/flags.make > /out/cpu-flags.txt || true
B=/work/build/bin; I="-I/work/llama-src/include -I/work/llama-src/ggml/include"
for t in gdn-equiv gdn-bench conv-graph-test; do
  g++ -O2 -std=c++17 -pthread -DGGML_MAX_NAME=128 $I -o /work/$t /tests/$t.cpp -L$B -lllama -lggml -lggml-cpu -lggml-base -Wl,-rpath,$B
done
. /tests/harness-check.sh
mkdir -p /out/equiv /out/graph
run_pair gdn-equiv /work/gdn-equiv ENCLAVE_GGML_GDN_NTSNAP /out/equiv
CONV_TEST_CPU_BACKEND=$B/libggml-cpu.so run_graph /work/conv-graph-test /model/m.gguf /out/graph ENCLAVE_GGML_GDN_NTSNAP
# informational: cold-state timing on THIS build (the production CPU path)
for v in 1 0 0 1 1 0 0 1; do printf "ntsnap=%s " $v; ENCLAVE_GGML_GDN_NTSNAP=$v /work/gdn-bench 2 8 1920 2 48 | head -1; done | tee /out/ntsnap-cold.txt
for v in 1 0 0 1; do printf "ntsnap=%s " $v; ENCLAVE_GGML_GDN_NTSNAP=$v /work/gdn-bench 2 8 1920 1 48 | head -1; done | tee /out/ntsnap-cold-control.txt
echo "ALL CHECKS PASSED"
