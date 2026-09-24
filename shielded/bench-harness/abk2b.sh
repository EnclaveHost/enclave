#!/bin/bash
# speculation depth re-test under changed per-row costs (regrow, ntsnap, argmax):
# k=1 vs k=2, ABBA x3, current best configuration, run10 gates
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 ELL_DIR=$M/ell-conv CPU_SO=$M/llama-conv/bin/libggml-cpu.so ENCLAVE_GGML_CONV_INPLACE=1
export BENCH=$B/bin-fast/bench-spec2
sha256sum $CPU_SO $M/llama-conv/bin/libggml-base.so $BENCH /home/steven/Projects/enclave/wasm/ggml-shielded/libggml-shielded.so > $B/k2.ids
run() { bash $B/waitfree.sh; bash $B/waitquiet3.sh; WORKERS_OVERRIDE="$FIT" $B/run10.sh kd$2-$1 $2 8 64; echo "  plain-hash $(grep -h 'plain tokens' $B/kd$2-$1.err | md5sum | cut -c1-12)"; }
run 3 1; run 3 2; run 4 2; run 4 1
echo QUEUE-DONE
