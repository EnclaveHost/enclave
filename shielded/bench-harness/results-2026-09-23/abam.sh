#!/bin/bash
# the bench's greedy argmax: original (lg[b] reload) vs register-max form, same
# engine binaries; identical outputs required (plain-token hash per run)
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 ELL_DIR=$M/ell-conv CPU_SO=$M/llama-conv/bin/libggml-cpu.so ENCLAVE_GGML_CONV_INPLACE=1
sha256sum $CPU_SO $M/llama-conv/bin/libggml-base.so $B/bench-spec2.slow-argmax $B/bench-spec2.fast /home/steven/Projects/enclave/wasm/ggml-shielded/libggml-shielded.so > $B/am.ids
run() { bash $B/waitfree.sh; bash $B/waitquiet.sh; bin=$B/bench-spec2.fast; [ "$2" = slow ] && bin=$B/bench-spec2.slow-argmax
  BENCH=$bin WORKERS_OVERRIDE="$FIT" $B/run7.sh am-$2-$1 1 8 64; echo "  plain-hash $(grep -h 'plain tokens' $B/am-$2-$1.err | md5sum | cut -c1-12)"; }
run 1 slow; run 1 fast; run 2 fast; run 2 slow; run 3 slow; run 3 fast
echo QUEUE-DONE
