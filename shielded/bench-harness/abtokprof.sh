#!/bin/bash
# op-level check of the token-fused GATED_DELTA_NET: the [opprof-rows] 2-row
# bucket is verify work only (plain decode is 1 row, prefill 17+), so its mean
# per call measures the kernel directly, independent of the GPU-side spread.
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 ELL_DIR=$M/ell-conv CPU_SO=$M/llama-conv/bin/libggml-cpu.so
run() { bash $B/waitfree.sh; bash $B/waitquiet.sh; v=1; [ "$2" = off ] && v=0
  WORKERS_OVERRIDE="$FIT" ENCLAVE_OP_PROFILE=1 ENCLAVE_GGML_CONV_INPLACE=1 ENCLAVE_GGML_GDN_TOKFUSE=$v $B/run7.sh tp-$2-$1 1 8 64; }
run 1 off; run 1 on; run 2 on; run 2 off
echo QUEUE-DONE
