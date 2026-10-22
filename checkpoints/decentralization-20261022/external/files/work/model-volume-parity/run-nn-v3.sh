#!/usr/bin/env bash
# The nn runtime (immutable; v3 = v2 with the probe REQUIRED to pass: its own output is shown, and the preload end to end runs whatever the
# probe said). runtime-set.sh compose with NN_RUNTIME_DIR (the pinned Shield-release runtime, CPU backend only); the
# probe's exact command with its stderr, and a load-only variant, so a refusal says why; a plain compose claims no nn;
# then test-modelvol-preload.sh on the composed set (it states the runtime marker in its own fixture).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
nn="$here/cache/shield-rt-b9be6a09"
(cd "$nn" && sha256sum -c --quiet ../shield-rt-b9be6a09.sha256) || exit 1
m4="$here/tree/isolation/m4"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fails=0
NN_RUNTIME_DIR="$nn" sh "$m4/runtime-set.sh" compose "$t/rt" || { echo "FAIL compose"; exit 1; }
ls "$t/rt" "$t/rt/backends"
[ "$(ls "$t/rt/backends")" = libggml-cpu.so ] && echo "ok   CPU backend only" || { echo "FAIL backends"; fails=$((fails + 1)); }
for f in libggml-shielded.so calib shield-model shield-compact-weights.enabled; do
  [ ! -e "$t/rt/$f" ] && [ ! -e "$t/rt/backends/$f" ] || { echo "FAIL $f reached the CPU set"; fails=$((fails + 1)); }
done
grep -q '"version":"49.0.0"' "$t/rt/runtime.json" && echo "ok   runtime.json names wasmtime 49.0.0" || { echo "FAIL runtime.json"; fails=$((fails + 1)); }
if [ -e "$t/rt/nn-ggml.enabled" ]; then echo "ok   nn-ggml.enabled from the real preload probe"; else echo "FAIL no nn-ggml.enabled"; fails=$((fails + 1)); fi
echo "== the probe's command, with its output"
mkdir -p "$t/probe/probe"; python3 "$m4/tiny-gguf.py" "$t/probe/probe/model.gguf" --vocab 512
run_probe() {  # <wat>
  ENCLAVE_GGML_BACKEND_DIR="$t/rt/backends" ENCLAVE_GGML_N_GPU_LAYERS=0 ENCLAVE_NN_SERVE_BYTES=1073741824 ENCLAVE_NN_SERVE_KIND=RAM \
    timeout 60 "$t/rt/ld-linux-x86-64.so.2" --library-path "$t/rt" "$t/rt/wasmtime" run -C cache=n -S nn -S "nn-graph=ggml::$t/probe/probe" \
    --invoke 'run()' "$1" 2>&1 | grep -v '^create_tensor\|^llama_model_loader\|^print_info\|^load_tensors\|^\.\+$' | tail -25
  echo "probe rc=${PIPESTATUS[0]}"
}
run_probe "$m4/nn-probe.wat"
sed 's/(if (i32.ne (call $init (i32.load (i32.const 64)) (i32.const 68)) (i32.const 0)) (then (return (i32.const 2))))//' "$m4/nn-probe.wat" > "$t/load-only.wat"
echo "== load_by_name only"; run_probe "$t/load-only.wat"
sh "$m4/runtime-set.sh" compose "$t/plain" || { echo "FAIL plain compose"; fails=$((fails + 1)); }
[ ! -e "$t/plain/nn-ggml.enabled" ] && [ ! -e "$t/plain/backends" ] && echo "ok   a plain compose claims no nn-ggml" || { echo "FAIL a plain compose claimed nn"; fails=$((fails + 1)); }
sh "$m4/test-modelvol-preload.sh" "$t/rt" "$here/cache/ggml-probe.wasm" || fails=$((fails + 1))
echo "=== run-nn-v2 failed=$fails"
[ $fails -eq 0 ]
