#!/bin/bash
# The graph-slot correctness matrix: every conv-graph-test scenario (plain, spec,
# lifetime, multi) with the KV cache per-sequence AND unified, each run twice --
# LLAMA_GRAPH_SLOT_ALT=1 (the small-batch slot on) and =0 (off, the reference) --
# and the two runs must both finish, report the same nonzero step/row/byte
# counts and dump byte-identical logits (run_graph in harness-check.sh).
#
#   graph-slot-check.sh CONV_GRAPH_TEST MODEL.gguf OUTDIR     (CONV_TEST_CPU_BACKEND set)
#
# Exit 0 only if every cell passes. On the official tree before the
# multi-sequence reservation fix, multi with the per-sequence cache aborts in the
# slot-on arm (GGML_ASSERT(ggml_can_repeat) in ggml_mul).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/harness-check.sh"
bin=$1 model=$2 out=$3
bad=0
for kv in 0 1; do
  for scen in plain spec lifetime multi; do
    d="$out/kv$kv-$scen"; mkdir -p "$d"
    if res=$(CONV_TEST_KV_UNIFIED=$kv run_graph "$bin" "$model" "$d" LLAMA_GRAPH_SLOT_ALT "$scen" 2>&1); then
      echo "PASS kv_unified=$kv $scen: ${res#OK: }"
    else
      echo "FAIL kv_unified=$kv $scen: $res"; bad=1
    fi
  done
done
[ $bad -eq 0 ] && echo "GRAPH-SLOT MATRIX PASS" || echo "GRAPH-SLOT MATRIX FAIL"
exit $bad
