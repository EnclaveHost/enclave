#!/bin/bash
# Host fixture for payload/anchor_bench_records.h (BENCH.md): formats a 3-trial capture with the engine's own record code,
# checks the oversized guard / null counters / escaping, validates JSON + key sets, and runs the repeat parser when
# BENCH_PARSER points at it. Exit 0 = pass.
set -u; H=$(cd "$(dirname "$0")" && pwd -P); O=$(mktemp -d); M=$(printf 'a%.0s' $(seq 64)); K=$(printf 'b%.0s' $(seq 64))
g++ -std=c++17 -Wall -Wextra -I"$H/../payload" -o "$O/t" "$H/bench-records-test.cpp" || exit 2
TEXT_SHA=$(python3 -c "import hashlib; print(hashlib.sha256(' Paris.\n\"The\" capital of Germany is Berlin.\t\x01end'.encode()).hexdigest())")
"$O/t" "$O/capture.log" "$M" "$K" "$TEXT_SHA" || exit 1
python3 - "$O/capture.log" <<'PY' || exit 1
import json, sys
keys={'session':{'record','trials','model_sha256','calib_digest','snapshot_bytes','snapshot_ms','prompt_observe_us','n_past','first_token','prompt_tokens','prefill_ms','mtp_requested_k','mtp_fallback','counters_available','settings','not_restored'},
 'begin':{'record','trial','restore_us','counters_before'},'result':{'record','trial','status','mtp_fallback','generated','decode_us','decode_tokens','steady_us','steady_tokens','mtp','text_sha256','completion','counters_after'},
 'end':{'record','trials','completed','reason','identical_text','identical_mtp','generated_total','any_failed'}}
n=0; ok=True
for l in open(sys.argv[1]):
    assert l.startswith('VSOCK BENCH v1 '); r=json.loads(l[len('VSOCK BENCH v1 '):]); n+=1
    if set(r)!=keys[r['record']]: ok=False; print('KEYSET', r['record'], set(r)^keys[r['record']])
    for c in ('counters_before','counters_after'):
        if c in r: assert set(r[c])=={'offloaded_nodes','local_nodes','macs','gmac','verify_fail','pads_used','pads_missed'}
print(json.dumps(dict(records=n, json_valid=True, keysets=ok))); sys.exit(0 if ok else 1)
PY
if [ -n "${BENCH_PARSER:-}" ] && [ -f "$BENCH_PARSER" ]; then python3 "$BENCH_PARSER" "$O/capture.log" --model-sha256 "$M" --calib-digest "$K" > "$O/parse.json" && python3 -c "import json; print('parser:', json.load(open('$O/parse.json'))['status'])" || { echo "parser REJECTED"; exit 1; }; fi
