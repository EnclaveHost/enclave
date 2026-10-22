#!/usr/bin/env bash
# The nn runtime (immutable; v1): runtime-set.sh compose with NN_RUNTIME_DIR (the pinned Shield-release runtime, CPU
# backend only) must carry backends/libggml-cpu.so and nn-ggml.enabled (probe-nn-ggml.sh: a graph REALLY preloaded and
# loaded by name) and no Shield GPU backend or calibration; a plain compose (the host's wasmtime) carries neither; then
# the preload end to end (test-modelvol-preload.sh) on the composed set.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
nn="$here/cache/shield-rt-b9be6a09"
(cd "$nn" && sha256sum -c --quiet ../shield-rt-b9be6a09.sha256)
m4="$here/tree/isolation/m4"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
NN_RUNTIME_DIR="$nn" sh "$m4/runtime-set.sh" compose "$t/rt"
ls -la "$t/rt" "$t/rt/backends"
[ "$(cat "$t/rt/nn-ggml.enabled")" = 1 ] || { echo "FAIL the composed nn runtime has no nn-ggml.enabled"; exit 1; }
[ "$(ls "$t/rt/backends")" = libggml-cpu.so ] || { echo "FAIL the backends are not the CPU one alone"; exit 1; }
for f in libggml-shielded.so calib shield-model shield-compact-weights.enabled; do
  [ ! -e "$t/rt/$f" ] && [ ! -e "$t/rt/backends/$f" ] || { echo "FAIL $f reached the CPU set"; exit 1; }
done
grep -q '"version":"49.0.0"' "$t/rt/runtime.json" || { echo "FAIL runtime.json"; cat "$t/rt/runtime.json"; exit 1; }
echo "ok   NN_RUNTIME_DIR compose: wasmtime 49.0.0, CPU backend only, nn-ggml.enabled from a real preload"
sh "$m4/runtime-set.sh" digest "$t/rt"
sh "$m4/runtime-set.sh" compose "$t/plain"
[ ! -e "$t/plain/nn-ggml.enabled" ] && [ ! -e "$t/plain/backends" ] || { echo "FAIL a plain compose claimed nn"; exit 1; }
echo "ok   a plain compose (the host's wasmtime) claims no nn-ggml"
sh "$m4/test-modelvol-preload.sh" "$t/rt" "$here/cache/ggml-probe.wasm"
echo "run-nn-v1: PASS"
