#!/bin/bash
set -euo pipefail
w=/home/steven/enclave-bench/v100-shield-20260927/reproduce
export TEST_CPU="$w/engine-avx512/bin/libggml-cpu.so" TEST_THREADS=6 TEST_REFILL=16 SHIELDED_REFILL_VECTOR_CRT=1 SHIELDED_CPU_MAIN=0 SHIELDED_CPU_HELPER=1 SHIELDED_CPU_REST=7-15,23-31 LD_PRELOAD="$w/omp-place6.so"
TEST_LABEL=native-local-team6-repeat python3 -u "$w/native.py"
TEST_LABEL=native-local-team6-long TEST_STEPS=256 python3 -u "$w/native.py"
