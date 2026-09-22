#!/usr/bin/env bash
# google-lane-run.sh <prompts.txt> -- run the SAME task prompts through Google's own NPU lane.
#
# This is the parity baseline that was outstanding for most of this campaign. Getting it to run took
# three separate version matches, none of which is guessable from the error messages:
#
#   1. The RUNTIME. Every published .litertlm is format 1.5 (the magic is followed by two LE u32s; check
#      with `head -c16 | xxd`), while the local LiteRT-LM tree builds 1.6. A 1.6 runtime loads a 1.5
#      package and then fails inside the decoder with "Invalid begin and size" at a SLICE node. Upstream
#      history pins the boundary: c7adc1bf took the constant 5 -> 6, so c7adc1bf^ (4698342e) is the last
#      1.5 runtime. A blobless clone plus `git checkout` gets there in seconds.
#   2. The BUILD. ANDROID_NDK_HOME must be set or bazel cannot resolve a CC toolchain; the prebuilt .so
#      files are git-lfs pointers that must be fetched (there is no git-lfs binary here, so the batch API
#      does it); and rules_rust needs a sane PATH via --action_env or its linker cannot find ld.
#   3. The DISPATCH library. It is loaded from the MODEL's directory, not LD_LIBRARY_PATH, and the version
#      must match: of v2.1.5, v2.1.6 and v2.2.0 shipped beside the package, only v2.1.6 works with the
#      1.5 runtime. The other two report "Unsupported dispatch runtime version" or abort.
#
#   OUT=/tmp/gl ./google-lane-run.sh quality-prompts.txt
set -uo pipefail
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; [ -n "${SERIAL:-}" ] && ADB="$ADB -s $SERIAL"
OUT="${OUT:-/tmp/google-lane}"; mkdir -p "$OUT"
RUNNER="${RUNNER:-/data/local/tmp/lm15}"
MODELDIR="${MODELDIR:-/data/local/tmp/enclave-tensor-npu-1}"
MODEL="${MODEL:-$MODELDIR/model.litertlm}"
LIBS="${LIBS:-/data/local/tmp/d15}"
PROMPTS="${1:?usage: $0 prompts.txt}"

"$ADB" shell "[ -f $MODELDIR/libLiteRtDispatch_GoogleTensor.so ] || echo MISSING" | tr -d '\r' | grep -q MISSING && {
  echo "REFUSING: no dispatch library beside the model at $MODELDIR"; exit 2; }
printf '# google NPU lane, %s\n' "$(date -Is)" > "$OUT/BUILD"
"$ADB" shell "head -c 16 $MODEL | xxd" 2>/dev/null | tr -d '\r' | head -1 >> "$OUT/BUILD"
cat "$OUT/BUILD"

mapfile -t PLIST < "$PROMPTS"
n=0
for line in "${PLIST[@]}"; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue;; esac
  p="${line%%	*}"
  n=$((n+1)); id=$(printf '%02d' "$n")
  printf '%s\n' "$p" > "$OUT/$id.prompt"
  [ -s "$OUT/$id.raw" ] && { echo "[$id] cached"; continue; }
  echo "[$id] $p"
  "$ADB" shell "cd /data/local/tmp && LD_LIBRARY_PATH=$LIBS timeout 600 $RUNNER --backend=npu \
      --model_path=$MODEL --input_prompt='$p' 2>&1" < /dev/null | tr -d '\r' > "$OUT/$id.raw"
  # the reply is what sits between the echoed prompt and the benchmark block
  awk -v p="input_prompt: $p" 'index($0,p){f=1; sub(/.*input_prompt: /,""); sub(/^.*\$/,""); next}
       /^BenchmarkInfo:/{f=0} f' "$OUT/$id.raw" | sed '1{/^$/d}' > "$OUT/$id.txt"
  grep -oE "Decode Speed: [0-9.]+ tokens/sec" "$OUT/$id.raw" | tail -1 > "$OUT/$id.rate"
done
echo; echo "runs in $OUT"
