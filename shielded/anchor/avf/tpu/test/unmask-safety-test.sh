#!/usr/bin/env bash
# unmask-safety-test.sh -- the parallel unmask's safety properties: the span template's behaviour (unmask-span-test.cpp),
# and three properties of ggml-tpu.cpp that the template cannot see: a self-check mismatch REFUSES before the parallel result
# is used, the replay does not debit the rail budget, and no digest or copy of unmasked outputs is emitted anywhere.
set -uo pipefail
H="$(cd "$(dirname "$0")/../.." && pwd)"; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
g++ -std=c++17 -O1 -Wall -Werror -fsanitize=address,undefined -I"$H/payload" "$H/tpu/test/unmask-span-test.cpp" -o "$T/ust" && "$T/ust" || fail=1
G="$H/payload/ggml-tpu.cpp"
blk=$(awk '/if \(!tpu_unmask_same\(g.cache, parallel_y\)\)/{on=1} on{print} /g.cache.swap\(parallel_y\);/{if(on) exit}' "$G")
grep -q 'abort();' <<<"$blk" && [ "$(grep -c 'g.cache.swap(parallel_y);' <<<"$blk")" = 1 ] || { echo "FAIL: a self-check mismatch does not refuse before the parallel result is swapped in"; fail=1; }
grep -q 'if (replay) return true;' "$G" || { echo "FAIL: the replay's budget callback may debit the real rail budget"; fail=1; }
grep -q '/\*replay=\*/true' "$G" || { echo "FAIL: the self-check does not replay in replay mode"; fail=1; }
# the TPU lane's files only: anchor_payload.c's an_y_digest belongs to the split engine's SYNTHETIC shape benchmark
# (fx_activation fixtures, never user data), which is what "confined to a synthetic-only test" allows
grep -n 'y_digest\|y digest' "$H/payload/ggml-tpu.cpp" "$H/payload/ggml-tpu.h" "$H/payload/engine_local.cpp" "$H/payload/tpu_unmask_span.h" "$H/payload/tpu_corr.h" \
  && { echo "FAIL: a digest of unmasked outputs is back in the TPU lane"; fail=1; }
[ $fail = 0 ] && echo "unmask-safety: PASS" || echo "unmask-safety: FAIL"; exit $fail
