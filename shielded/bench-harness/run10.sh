#!/bin/bash
# run9.sh with the desktop compositor recorded separately (compositor= in .meta).
# run8.sh + foreign CPU sampled DURING the run in 5 s windows (.intr), replacing
# ps's lifetime-average check after it.
# run7.sh + the bench process's huge-page footprint at +45/+75 s (.thp).
# run6.sh + a 1 Hz all-core frequency / socket power / Tctl sample (.cpu).
# run5.sh + a passive 2 Hz thread-placement sample (.threads, tsample.py).
# run4.sh + per-run worker log slices (.w1/.w2) and a 1 Hz GPU sample (.gpu).
# run2.sh + every refusal form in .meta, and VALID from validate.py (the one complete check).
# (run2.sh's own notes follow.) run.sh with two fixes. A separate file, never edited while a queue runs.
#
# 1. The intruder filter no longer flags my own monitoring. `ps` reports ~100%
#    for itself because its lifetime average covers a few milliseconds, so the
#    watchdog's ps and this ps caught each other and excluded two good runs
#    (rw-fit-5, the session's highest plain reading, and sa-spindef-2).
# 2. A longer settle before each run. Class-B refusals ("cannot reserve N: the
#    card has M free (the pool holds ...)") happen while a previous run's
#    allocation is still releasing, and that is what leaves the residual fp32
#    fallback node. 45 s was not always enough.
MY=/home/steven/enclave-bench
B=$MY/b27
REPO=/home/steven/Projects/enclave
GS=$REPO/wasm/ggml-shielded
ELL=${ELL_DIR:-$MY/ell-alias}
MODEL=/home/steven/Projects/enclave-models/qwen3.8-27b-mtp-q4-vl-gguf/Qwen3.8-27B-UD-Q4_K_XL.gguf
LABEL=$1; K=${2:-1}; THREADS=${3:-8}; N=${4:-64}
PROMPT=${PROMPT:-"Explain in one paragraph why the sky is blue, then list three related phenomena."}

n=$(pgrep -x bench-spec2 | wc -l)
if [ "$n" -ne 0 ]; then echo "$LABEL ABORT: $n bench-spec2 already running"; exit 9; fi

GATE=${BUSY_GATE:-2.0}; WAITED=0
while :; do
  BUSY=$($B/cpubusy.sh)
  awk -v b="$BUSY" -v g="$GATE" 'BEGIN{exit !(b<g)}' && break
  [ "$WAITED" -ge 900 ] && { echo "$LABEL WARN: $BUSY foreign cores busy after ${WAITED}s; running anyway"; break; }
  sleep 13; WAITED=$((WAITED+15))
done
LOAD_PRE=$BUSY

export ENCLAVE_GGML_EXTRA_BUFTS=0 SHIELDED_PROFILE=1 SHIELDED_VERBOSE=1 LD_LIBRARY_PATH=$ELL${EXTRA_LD:+:$EXTRA_LD}
export SHIELDED_CALIB=${SHIELDED_CALIB:-$REPO/metal/shielded-overlay/calib/qwen3.8-27b-mtp-q4-vl-gguf.calib}
export BACKENDS=${CPU_SO:-$MY/llama-alias/bin/libggml-cpu.so}:${SHSO:-$GS/libggml-shielded.so}
export SHIELDED_WORKERS=${WORKERS_OVERRIDE:-$'127.0.0.1|9601|0|16000000000|/dev/shm/enclave-shielded-shm/card-0|67108864\n127.0.0.1|9602|0|16000000000|/dev/shm/enclave-shielded-shm/card-1|67108864'}
export SHIELDED_SO_FOR_STATS=${SHSO:-$GS/libggml-shielded.so}
export SHIELDED_MAX_M=${SHIELDED_MAX_M:-64} WARM=${WARM:-1} PREFILL_REPS=${PREFILL_REPS:-0}
export SHIELDED_REFILL_BATCH=${SHIELDED_REFILL_BATCH:-64} SHIELDED_POOL_DEPTH=${SHIELDED_POOL_DEPTH:-64}

t0=$(date +%s)
# per-run evidence for the run-to-run spread: each worker's log slice, and a 1 Hz
# GPU sample (clocks, power, temperature, throttle reasons) for both V100s
W1S=$(wc -l < $B/worker1-shm.log 2>/dev/null || echo 0); W2S=$(wc -l < $B/worker2-shm.log 2>/dev/null || echo 0)
nvidia-smi -i GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c,GPU-042eb279-e6e6-9866-5823-015b8d26946a \
  --query-gpu=timestamp,index,clocks.sm,clocks.mem,power.draw,temperature.gpu,clocks_throttle_reasons.active,utilization.gpu \
  --format=csv,noheader -l 1 > $B/$LABEL.gpu 2>/dev/null &
GPUMON=$!
python3 $B/tsample.py $B/$LABEL.threads > /dev/null 2>&1 &
TSAMP=$!
python3 $B/cpusample.py $B/$LABEL.cpu > /dev/null 2>&1 &
CSAMP=$!
K=$K THREADS=$THREADS LABEL=$LABEL ${BENCH:-$B/bench-spec2} "$MODEL" "$PROMPT" $N > $B/$LABEL.json 2> $B/$LABEL.err &
BPID=$!
# run8: the bench process's anonymous and huge-page footprint at +45 s and +75 s
( for t in 45 30; do sleep $t; [ -r /proc/$BPID/smaps_rollup ] || break
    echo "t+$t $(grep -E '^(Rss|Anonymous|AnonHugePages):' /proc/$BPID/smaps_rollup | tr -s ' ' | tr '\n' ' ')"; done ) > $B/$LABEL.thp 2>/dev/null &
THPS=$!
# run9: foreign CPU use sampled DURING the run, 5 s windows (cpunow.py), not ps's
# lifetime average after it; any process above 50% of a core in any window is an intruder
( while kill -0 $BPID 2>/dev/null; do h=$(python3 $B/cpunow.py 5 50); [ -n "$h" ] && echo "$(date +%s) $h"; done ) > $B/$LABEL.intr 2>/dev/null &
INTRS=$!
wait $BPID; rc=$?
kill $THPS $INTRS 2>/dev/null; wait $THPS $INTRS 2>/dev/null
kill $GPUMON $TSAMP $CSAMP 2>/dev/null; wait $GPUMON $TSAMP $CSAMP 2>/dev/null
tail -n +$((W1S + 1)) $B/worker1-shm.log > $B/$LABEL.w1 2>/dev/null; tail -n +$((W2S + 1)) $B/worker2-shm.log > $B/$LABEL.w2 2>/dev/null
LOAD_POST=$(cut -d' ' -f1 /proc/loadavg)
# Monitoring tools observe themselves at ~100%; they are not contention.
# run10: the desktop compositor is recorded, not counted as an intruder. It is
# busy only WHILE the cards work (a GPU monitor on screen, nvtop, animates and the
# compositor redraws), i.e. it is an effect of the benchmark itself, present in
# every run; it can only slow a run, never speed one. Everything else still is.
INTR_ALL=$(cut -d' ' -f2- $B/$LABEL.intr 2>/dev/null | tr ' ' '\n' | grep -v '^$' | awk -F: '{if($2>m[$1])m[$1]=$2} END{for(k in m) printf "%s:%s ", k, m[k]}')
INTRUDER=$(printf '%s' "$INTR_ALL" | tr ' ' '\n' | grep -v '^picom:' | grep -v '^$' | tr '\n' ' ' | head -c 120)
COMPOSITOR=$(printf '%s' "$INTR_ALL" | tr ' ' '\n' | grep '^picom:' | head -1)
A=$(grep -c 'exceeds the budget' $B/$LABEL.err 2>/dev/null)
Bc=$(grep -c 'cannot reserve' $B/$LABEL.err 2>/dev/null)
# Every refusal form, not two phrases: a split slice refusal is neither of the
# above and hid 258 refusals + local=210 under refusalA=0 refusalB=0 (sw-53-1).
SPLITREF=$(grep -cE '\] split: \S+ slice [0-9]+\.\.[0-9]+ refused on card' $B/$LABEL.err 2>/dev/null)
CPUONLY=$(grep -c 'all operations stay on CPU' $B/$LABEL.err 2>/dev/null)
echo "pre=$LOAD_PRE post=$LOAD_POST waited=${WAITED}s intruder=${INTRUDER:-none} compositor=${COMPOSITOR:-none} refusalA=$A refusalB=$Bc splitrefused=$SPLITREF cpuonly=$CPUONLY" > $B/$LABEL.meta
# VALID comes from the ONE complete check (validate.py: artifacts, rc, meta,
# refusals, fallback, verify_fail, output equality, observer), never from a
# partial one here.
VERDICT=$(python3 $B/validate.py $LABEL --rc $rc)
echo "$LABEL rc=$rc wall=$(( $(date +%s) - t0 ))s foreign=$LOAD_PRE refusalA=$A refusalB=$Bc splitrefused=$SPLITREF ${INTRUDER:+INTRUDER: $INTRUDER}"
echo "  $VERDICT"
python3 - "$B/$LABEL.json" <<'PY'
import json,sys
try:
    r=json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
    print(f"  plain {r['plain_tok_s']:.2f} | spec k={r['k']} {r['decode_tok_s']:.2f} tok/s, acc {r['acceptance_rate']:.3f}, identical={r['text_identical']}")
except Exception as e:
    print("  no json:", e)
PY
grep -h 'verify_fail\|offloaded=' $B/$LABEL.err | tail -1
sleep 90   # class-B refusals fire while a previous allocation is still releasing
