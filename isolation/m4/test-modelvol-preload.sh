#!/bin/sh
# Model-volume PRELOAD, end to end on the CPU: the per-app init's model-volume code (isolation/m2/modelvol.h, through
# testdata/modelvol-serve.c) stages two mounted volumes, budgets the ggml one against the guest's memory and execs the
# real nn-capable runtime with exactly the argv and environment a measured guest gives it; a wasi:http app built on
# load_by_name (enclave-apps/ggml-probe) then decodes through the preloaded graph, by the VOLUME's name. Cases:
#   preloaded   1024 MiB: GET /?graph=qwen-a decodes (n_vocab of the fixture model), the weights never in the app
#   data only   GET /?graph=data-b: a volume without a graph is mounted, never preloaded
#   budget      257 MiB (1 MiB past the reserve): the graph is not preloaded, so load_by_name fails - the shared
#               runtime's rule, mounted and listed but not preloaded past the tenant's memory
#   no runtime  without the runtime's nn-ggml marker: no -S nn and no preload in the argv the init builds (an app that
#               imports wasi:nn then cannot instantiate, as on the shared runtime without NN_ENABLED)
# The volumes are plain directories here: mounting them over dm-verity is test-modelvol-qemu.sh's subject.
#
# usage: test-modelvol-preload.sh <nn runtime dir> <ggml-probe.wasm>
#   (the runtime dir holds ld-linux-x86-64.so.2, wasmtime and its libraries, and backends/libggml-cpu.so)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
rt=${1:?usage: test-modelvol-preload.sh <nn runtime dir> <ggml-probe.wasm>}
app=${2:?usage: test-modelvol-preload.sh <nn runtime dir> <ggml-probe.wasm>}
for tool in gcc python3 curl; do command -v "$tool" >/dev/null || { echo "FAIL $tool is required"; exit 1; }; done
[ -r "$rt/backends/libggml-cpu.so" ] && [ -x "$rt/wasmtime" ] || { echo "FAIL $rt is not an nn runtime directory"; exit 1; }
d=$(mktemp -d)
pid=""
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$d"' EXIT
mkdir -p "$d/models/qwen-a" "$d/models/data-b" "$d/backends" "$d/stage"
python3 "$here/tiny-gguf.py" "$d/models/qwen-a/model.gguf" --vocab 151936 > /dev/null
echo "fixture data" > "$d/models/data-b/readme"
cp "$rt/backends/libggml-cpu.so" "$d/backends/"    # the CPU backend only: never the Shield GPU one
pin=$(printf '%064d' 0 | tr 0 1)
root=a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff
printf 'data-b %s 00ff 4096 4096 10 11 49152 none - %s\nqwen-a %s 00ff 4096 4096 10 11 49152 ggml model.gguf %s\n' \
  "$root" "$pin" "$root" "$pin" > "$d/table"
printf 'M1\nvol=qwen-a\nvol=data-b\n' > "$d/m1"
gcc -O2 -Wall -o "$d/serve" "$here/../m2/testdata/modelvol-serve.c" -DMV_ROOT="\"$d/models\"" -DMV_STAGE="\"$d/stage/nn-graph\"" \
  -DMV_TABLE="\"$d/table\"" -DMV_NN_MARKER="\"$d/nn-ggml.enabled\"" -DMV_BACKEND_DIR="\"$d/backends\"" -DMV_M1="\"$d/m1\""
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
fails=0
serve() {  # <label> <memory MiB> -> pid, $d/<label>.log; waits for /ping
  rm -rf "$d/stage"; mkdir -p "$d/stage"
  "$d/serve" "$rt" "$app" "127.0.0.1:$port" "$2" > "$d/$1.log" 2>&1 &
  pid=$!
  i=0
  until curl -fsS "http://127.0.0.1:$port/ping" > /dev/null 2>&1; do
    i=$((i + 1)); [ $i -gt 120 ] && { echo "FAIL $1: the runtime never served"; tail -20 "$d/$1.log" | sed 's/^/     /'; return 1; }
    kill -0 "$pid" 2>/dev/null || { echo "FAIL $1: the runtime exited"; tail -20 "$d/$1.log" | sed 's/^/     /'; return 1; }
    sleep 0.5
  done
}
stop() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=""; }
check() {  # <label> <what> <cond...>
  label=$1; what=$2; shift 2
  if "$@"; then echo "ok   $label: $what"; else echo "FAIL $label: $what"; grep -v '^MVSERVE argv' "$d/$label.log" | tail -8 | sed 's/^/     /'; fails=$((fails + 1)); fi
}
get() { curl -sS "http://127.0.0.1:$port$1" > "$d/body.json" 2>/dev/null || true; cat "$d/body.json"; }

: > "$d/nn-ggml.enabled"
serve preloaded 1024
check preloaded "the init's argv: -S nn, the graph staged under the volume's name, both preopens, the env names" \
  sh -c "tr '\n' ' ' < '$d/preloaded.log' | grep -qF 'MVSERVE argv -S MVSERVE argv nn MVSERVE argv -S MVSERVE argv nn-graph=ggml::$d/stage/nn-graph/qwen-a MVSERVE argv --dir MVSERVE argv $d/models/qwen-a::/models/qwen-a MVSERVE argv --dir MVSERVE argv $d/models/data-b::/models/data-b'"
check preloaded "the env: ENCLAVE_MODELS, the preload, 768 MiB of budget, the CPU backend" \
  sh -c "grep -qx 'MVSERVE env ENCLAVE_MODELS=qwen-a,data-b' '$d/preloaded.log' && grep -qx 'MVSERVE env ENCLAVE_NN_PRELOADS=qwen-a' '$d/preloaded.log' &&
         grep -qx 'MVSERVE env ENCLAVE_NN_SERVE_BYTES=805306368' '$d/preloaded.log' && grep -qx 'MVSERVE env ENCLAVE_GGML_BACKEND_DIR=$d/backends' '$d/preloaded.log'"
body=$(get "/?graph=qwen-a&steps=3")
check preloaded "load_by_name(\"qwen-a\") decodes through the preloaded graph ($body)" \
  python3 -c "import json,sys; b=json.loads(sys.argv[1]); assert b['graph']=='qwen-a' and b['n_vocab']==151936 and len(b['tokens'])==3, b" "$body"
body=$(get "/?graph=data-b")
check preloaded "a data-only volume is never a graph ($body)" grep -q 'load_by_name' "$d/body.json"
stop

serve budget 257
body=$(get "/?graph=qwen-a&steps=1")
check budget "1 MiB of budget: not preloaded, so load_by_name fails ($body)" \
  sh -c "grep -qx 'MVSERVE env ENCLAVE_NN_PRELOADS=' '$d/budget.log' && grep -q 'load_by_name' '$d/body.json' && ! grep -qF 'MVSERVE argv nn-graph=' '$d/budget.log'"
stop

rm -f "$d/nn-ggml.enabled"
rm -rf "$d/stage"; mkdir -p "$d/stage"
"$d/serve" "$rt" "$app" "127.0.0.1:$port" 1024 > "$d/nonn.log" 2>&1 & pid=$!
i=0; until grep -q '^MVSERVE env PATH' "$d/nonn.log" 2>/dev/null; do i=$((i + 1)); [ $i -gt 40 ] && break; sleep 0.25; done
check nonn "no nn marker: the init builds no -S nn, no graph and no preload values, only the preopens and ENCLAVE_MODELS" \
  sh -c "! grep -qx 'MVSERVE argv nn' '$d/nonn.log' && ! grep -q 'nn-graph' '$d/nonn.log' && ! grep -q '^MVSERVE env ENCLAVE_NN' '$d/nonn.log' &&
         grep -qx 'MVSERVE env ENCLAVE_MODELS=qwen-a,data-b' '$d/nonn.log' && grep -qx 'MVSERVE argv $d/models/qwen-a::/models/qwen-a' '$d/nonn.log' && [ ! -e '$d/stage/nn-graph' ]"
stop

[ $fails = 0 ] && echo "modelvol preload: PASS" || { echo "modelvol preload: FAIL ($fails)"; exit 1; }
