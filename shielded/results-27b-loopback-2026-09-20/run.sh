#!/bin/bash
# one 27B run through bench-spec. usage: run.sh LABEL [K] [THREADS] [N]   extra env passes through
S=/tmp/claude-1000/-home-steven-Projects-enclave/a64dfb78-8c4d-4d50-bb46-3af9325e2e95/scratchpad/b27
REPO=/home/steven/Projects/enclave
GS=$REPO/wasm/ggml-shielded
ELL=/home/steven/q4-calib-work/enclave-llamacpp-linux-x64-gpu/lib
MODEL=/home/steven/Projects/enclave-models/qwen3.8-27b-mtp-q4-vl-gguf/Qwen3.8-27B-UD-Q4_K_XL.gguf
LABEL=$1; K=${2:-1}; THREADS=${3:-8}; N=${4:-64}
PROMPT=${PROMPT:-"Explain in one paragraph why the sky is blue, then list three related phenomena."}
export ENCLAVE_GGML_EXTRA_BUFTS=0 SHIELDED_PROFILE=1 SHIELDED_VERBOSE=1 LD_LIBRARY_PATH=$ELL
export SHIELDED_CALIB=${SHIELDED_CALIB:-$REPO/metal/shielded-overlay/calib/qwen3.8-27b-mtp-q4-vl-gguf.calib}
if [ "${MODE:-shielded}" = shielded ]; then
  export BACKENDS=$ELL/libggml-cpu.so:${SHSO:-$GS/libggml-shielded.so}
  export SHIELDED_WORKERS=$'127.0.0.1|9601|0|25000000000\n127.0.0.1|9602|0|25000000000'
  export SHIELDED_SO_FOR_STATS=${SHSO:-$GS/libggml-shielded.so}
elif [ "$MODE" = cuda ]; then
  export BACKENDS=$ELL/libggml-cpu.so:$ELL/libggml-cuda.so N_GPU_LAYERS=${N_GPU_LAYERS:-99}
else
  export BACKENDS=$ELL/libggml-cpu.so
fi
t0=$(date +%s)
K=$K THREADS=$THREADS LABEL=$LABEL ${BENCH:-$GS/bench-spec} "$MODEL" "$PROMPT" $N > $S/$LABEL.json 2> $S/$LABEL.err
rc=$?
echo "$LABEL rc=$rc wall=$(( $(date +%s) - t0 ))s load=$(cut -d' ' -f1-3 /proc/loadavg) others=$(ps -eo pcpu,comm --sort=-pcpu | grep -v 'bench-spec\|shielded-w\|CPU\|%CPU' | head -2 | awk '{printf "%s:%s ", $2, $1}')"
python3 - "$S/$LABEL.json" <<'PY'
import json,sys
try:
    r=json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
    print(f"  plain {r['plain_tok_s']:.2f} tok/s ({r['plain_ms_per_tok']:.1f} ms/tok, prefill {r['plain_prefill_ms']:.0f} ms) | spec k={r['k']} {r['decode_tok_s']:.2f} tok/s, {r['mean_tokens_per_round']:.2f} tok/round, accept {r['acceptance_rate']:.2f}, draft {r['draft_ms_per_round']:.1f} ms verify {r['verify_ms_per_round']:.1f} ms/round, identical={r['text_identical']} | spec prefill {r['spec_prefill_ms']:.0f} ms | warm prefill {r.get('prefill_warm_ms', -1):.0f} ms x{r.get('prefill_reps', 0)}")
except Exception as e:
    print("  no json:", e)
PY
grep -h 'profile: exchanges\|\[bench\] shielded\|pool:' $S/$LABEL.err | tail -3

sleep 8
