#!/bin/bash
# the INTEGRATED OFFICIAL path: llama.cpp LLAMA_COMMIT + the llamacpp-toolchain
# patches + llamacpp-gdn-ntsnap.patch, built with the workflow's CPU flags
# (GGML_NATIVE=OFF: AVX2/FMA/F16C), engine drop ell-new, repo shielded backend
# and worker; ENCLAVE_GGML_GDN_NTSNAP 1 vs 0, ABBA x3, run10 gates
M=/home/steven/enclave-bench; B=$M/b27
FIT=$'127.0.0.1|9601|0|15500000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|15500000000|/dev/shm/enclave-shielded-shm/card-1|67108864'
export SHIELDED_SPLIT_COLS=1 SHIELDED_OVERLAP_VERIFY=1 SHIELDED_WEIGHT_BUDGET_FRAC=0.95 ELL_DIR=$M/ell-official CPU_SO=$M/official-build/bin/libggml-cpu.so
export BENCH=$B/bin-fast/bench-spec2
sha256sum $CPU_SO $M/official-build/bin/libggml-base.so $M/official-build/bin/libllama.so.0.0.1 $BENCH /home/steven/Projects/enclave/wasm/ggml-shielded/libggml-shielded.so /home/steven/Projects/enclave/shielded/worker-cuda/shielded-worker > $B/official.ids
run() { bash $B/waitfree.sh; bash $B/waitquiet3.sh; v=1; [ "$2" = off ] && v=0
  WORKERS_OVERRIDE="$FIT" ENCLAVE_GGML_GDN_NTSNAP=$v $B/run10.sh of-$2-$1 1 8 64; echo "  plain-hash $(grep -h 'plain tokens' $B/of-$2-$1.err | md5sum | cut -c1-12)"; }
run 1 off; run 1 on; run 2 on; run 2 off; run 3 off; run 3 on
echo QUEUE-DONE
