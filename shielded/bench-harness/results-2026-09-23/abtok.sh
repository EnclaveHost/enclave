#!/bin/bash
# token-fused GATED_DELTA_NET: ENCLAVE_GGML_GDN_TOKFUSE=0 vs =1, same binary and
# libraries (llama-conv, conv in place ON in both arms), interleaved pairs
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 SHIELDED_YIELD=0 ELL_DIR=$M/ell-conv CPU_SO=$M/llama-conv/bin/libggml-cpu.so
sha256sum $CPU_SO $M/llama-conv/bin/libggml-base.so $B/bench-spec2 /home/steven/Projects/enclave/wasm/ggml-shielded/libggml-shielded.so > $B/tk.ids
run() { bash $B/waitfree.sh; bash $B/waitquiet.sh; v=1; [ "$2" = off ] && v=0
  WORKERS_OVERRIDE="$FIT" ENCLAVE_GGML_CONV_INPLACE=1 ENCLAVE_GGML_GDN_TOKFUSE=$v $B/run7.sh tk-$2-$1 1 8 64; }
run 1 off; run 1 on; run 2 on; run 2 off; run 3 off; run 3 on; run 4 on; run 4 off
echo QUEUE-DONE
