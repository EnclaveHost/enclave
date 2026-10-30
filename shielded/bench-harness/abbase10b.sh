#!/bin/bash
# clean baseline of the current best configuration (bench argmax fixed, regrow,
# ntsnap; no profilers): six runs, gated on CURRENT foreign CPU (waitquiet2),
# foreign CPU sampled during each run (run10 .intr; compositor recorded separately), huge pages (.thp), placement (.threads)
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 ELL_DIR=$M/ell-conv CPU_SO=$M/llama-conv/bin/libggml-cpu.so ENCLAVE_GGML_CONV_INPLACE=1
export BENCH=$B/bin-fast/bench-spec2
sha256sum $CPU_SO $M/llama-conv/bin/libggml-base.so $BENCH /home/steven/Projects/enclave/wasm/ggml-shielded/libggml-shielded.so > $B/base10.ids
for i in 2 3 4 5 6 7; do bash $B/waitfree.sh; bash $B/waitquiet3.sh
  echo "bt-$i pre: $(grep -E '^(MemFree|AnonHugePages):' /proc/meminfo | tr -s ' ' | tr '\n' ' ') now:[$(python3 $B/cpunow.py 3 10)]"
  WORKERS_OVERRIDE="$FIT" $B/run10.sh bt-$i 1 8 64; echo "  plain-hash $(grep -h 'plain tokens' $B/bt-$i.err | md5sum | cut -c1-12) thp: $(tail -1 $B/bt-$i.thp)"; done
echo QUEUE-DONE
