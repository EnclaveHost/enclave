#!/bin/bash
# six clean baseline runs of the current best configuration (fast argmax,
# regrow, ntsnap; no profilers), each recording the bench process's huge-page
# footprint (.thp) and the system's free memory / THP before the run
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 ELL_DIR=$M/ell-conv CPU_SO=$M/llama-conv/bin/libggml-cpu.so ENCLAVE_GGML_CONV_INPLACE=1
export BENCH=$B/bin-fast/bench-spec2
sha256sum $CPU_SO $M/llama-conv/bin/libggml-base.so $BENCH /home/steven/Projects/enclave/wasm/ggml-shielded/libggml-shielded.so > $B/thp2.ids
for i in 1 2 3 4 5 6; do bash $B/waitfree.sh; bash $B/waitquiet.sh
  echo "th-$i pre: $(grep -E '^(MemFree|AnonHugePages):' /proc/meminfo | tr -s ' ' | tr '\n' ' ')"
  WORKERS_OVERRIDE="$FIT" $B/run8.sh th-$i 1 8 64; echo "  plain-hash $(grep -h 'plain tokens' $B/th-$i.err | md5sum | cut -c1-12) thp: $(tail -1 $B/th-$i.thp)"; done
echo QUEUE-DONE
