#!/bin/bash
# (1) the bench argmax pairs 3-5 (pair 2 dropped: intruder), (2) the ntsnap
# 27B op-profiled pairs (fast bench, ENCLAVE_OP_PROFILE=1, NTSNAP 0 vs 1)
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 ELL_DIR=$M/ell-conv CPU_SO=$M/llama-conv/bin/libggml-cpu.so ENCLAVE_GGML_CONV_INPLACE=1
sha256sum $CPU_SO $M/llama-conv/bin/libggml-base.so $B/bench-spec2.slow-argmax $B/bench-spec2.fast /home/steven/Projects/enclave/wasm/ggml-shielded/libggml-shielded.so > $B/next.ids
am() { bash $B/waitfree.sh; bash $B/waitquiet.sh; bin=$B/bench-spec2.fast; [ "$2" = slow ] && bin=$B/bench-spec2.slow-argmax
  BENCH=$bin WORKERS_OVERRIDE="$FIT" $B/run7.sh am-$2-$1 1 8 64; echo "  plain-hash $(grep -h 'plain tokens' $B/am-$2-$1.err | md5sum | cut -c1-12)"; }
np() { bash $B/waitfree.sh; bash $B/waitquiet.sh; v=1; [ "$2" = off ] && v=0
  BENCH=$B/bench-spec2.fast WORKERS_OVERRIDE="$FIT" ENCLAVE_OP_PROFILE=1 ENCLAVE_GGML_GDN_NTSNAP=$v $B/run7.sh np-$2-$1 1 8 64; echo "  plain-hash $(grep -h 'plain tokens' $B/np-$2-$1.err | md5sum | cut -c1-12)"; }
am 3 slow; am 3 fast; am 4 fast; am 4 slow; am 5 slow; am 5 fast
np 1 off; np 1 on; np 2 on; np 2 off
echo QUEUE-DONE
