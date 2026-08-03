#!/bin/bash
# One serve+probe leg for the mm18 rewind-verify A/B matrix.
#   BIN=<wasmtime binary> LIB=<shim/lib dir> RS=<n_rs_seq or empty>
#   CFGKIND=plain|lookup4 PORT=<port> PROMPT=<text> TAG=<label>
# Emits: TAG<TAB>sha16<TAB>len<TAB>drafted/accepted and writes the full text
# + done frame to $S/ab-$TAG.txt / .done.json
set -u
S=$(cd "$(dirname "$0")" && pwd)
OLD=$HOME/.cache/specbench-deps
: "${BIN:?}" "${LIB:?}" "${CFGKIND:?}" "${PORT:?}" "${PROMPT:?}" "${TAG:?}"
RS=${RS:-}

CFG=$(python3 - "$CFGKIND" <<'EOF'
import json, sys
kind = sys.argv[1]
if kind.startswith("mtp"):
    vol = "qwen3.5-9b-mtp-gguf"
    m = {"name":"qwen3.5-9b-mtp","backend":"ggml","n_layers":32,"n_kv_heads":4,
         "head_dim":256,"kv_layers":8,"vocab":248320,"eos":[248046,248044],
         "template":"chatml","thinking":False,"temperature":0.0}
else:
    vol = "qwen3.5-0.8b-gguf"
    m = {"name":"qwen3.5-0.8b","backend":"ggml","n_layers":24,"n_kv_heads":2,
         "head_dim":256,"kv_layers":6,"vocab":248320,"eos":[248046,248044],
         "template":"chatml","thinking":False,"temperature":0.0}
cfg = dict(m); cfg["model_volume"]=vol
cfg["max_new_cap"]=160; cfg["default_max_new"]=160
if kind == "lookup4":
    cfg["draft"]="lookup"; cfg["draft_tokens"]=4
if kind == "mtp4":
    cfg["draft"]="mtp"; cfg["draft_tokens"]=4; cfg["draft_p_min"]=0.4
if kind == "mtp4think":
    cfg["draft"]="mtp"; cfg["draft_tokens"]=4; cfg["draft_p_min"]=0.4
    cfg["thinking"]=True; cfg["think_budget"]=48
    m["thinking"]=True; m["think_budget"]=48
cfg["models"]={vol:m}
print(json.dumps(cfg))
EOF
)

ENVV=(ENCLAVE_GGML_BACKEND_DIR="$LIB" ENCLAVE_GGML_N_GPU_LAYERS=${NGL:-99}
      ENCLAVE_GGML_N_CTX=${NCTX:-4096} ENCLAVE_GGML_MAX_SESSIONS=2
      LD_LIBRARY_PATH="$LIB:$OLD/cuda-tk/lib64")
[ -n "$RS" ] && ENVV+=(ENCLAVE_GGML_N_RS_SEQ="$RS")

case "$CFGKIND" in
  mtp*) VOL=qwen3.5-9b-mtp-gguf ;;
  *)    VOL=qwen3.5-0.8b-gguf ;;
esac
env "${ENVV[@]}" \
"$BIN" serve -S cli -S nn \
  -S "nn-graph=ggml::$HOME/Projects/enclave-models/$VOL" \
  --addr 127.0.0.1:$PORT --dir "$HOME/Projects/enclave-models::/models" \
  --env ENCLAVE_CONFIG="$CFG" --env ENCLAVE_MODELS=$VOL --env ENCLAVE_GGML_N_CTX=${NCTX:-4096} \
  "${WASM:-$HOME/Projects/enclave-apps/llm-chat/target/wasm32-wasip2/release/llm_chat.wasm}" \
  > "$S/ab-serve-$TAG.log" 2>&1 &
PID=$!
# model load can take a bit on first touch; poll
for i in $(seq 1 30); do
  sleep 2
  curl -s -m 5 http://127.0.0.1:$PORT/v1/models 2>/dev/null | grep -q qwen && break
done
BODY=$(python3 - "$PROMPT" <<'EOF'
import json,sys
print(json.dumps({"messages":[{"role":"user","content":sys.argv[1]}],
                  "max_tokens":160,"temperature":0}))
EOF
)
RAW=$(curl -s -m 300 -H "content-type: application/json" -X POST \
      "http://127.0.0.1:$PORT/chat" -d "$BODY" 2>/dev/null)
kill $PID 2>/dev/null; wait $PID 2>/dev/null
TXT=$(printf '%s' "$RAW" | grep -o '"delta":"[^"]*"' | sed 's/"delta":"//;s/"$//' | tr -d '\n')
printf '%s' "$RAW" | grep '"done":true' | tail -1 > "$S/ab-$TAG.done.json"
DA=$(python3 - "$S/ab-$TAG.done.json" <<'EOF'
import json,sys
try:
    d=json.loads(open(sys.argv[1]).read().strip().removeprefix("data: "))
    v=d.get("verb_us",{}) or {}
    keys=",".join(sorted(set(k.split("#")[0] for k in v)))
    print(f'{d.get("draft_tokens",0)}/{d.get("draft_accepted",0)} '
          f'tps={d.get("tok_per_s",0)} verbs={keys[:140]}')
except Exception as e:
    print(f"parse_err:{e}")
EOF
)
printf '%s\n' "$TXT" > "$S/ab-$TAG.txt"
printf '%s\t%s\t%s\t%s\n' "$TAG" "$(printf '%s' "$TXT" | sha256sum | cut -c1-16)" "${#TXT}" "$DA"
grep -iE 'error|panic|abort' "$S/ab-serve-$TAG.log" | head -3
