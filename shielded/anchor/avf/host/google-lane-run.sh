#!/usr/bin/env bash
# google-lane-run.sh <prompts.txt> -- run the SAME task prompts through Google's own NPU lane.
#
# Getting this lane to run at all took three version matches (see TPU.md): the runtime must be format 1.5
# (c7adc1bf^ = 4698342e upstream, NOT the 1.6 the local tree builds), the dispatch library must be v2.1.6
# and must sit beside the MODEL rather than on LD_LIBRARY_PATH, and the build needs ANDROID_NDK_HOME, the
# git-lfs objects fetched, and a sane PATH for rules_rust.
#
# EVIDENCE RULES, each of which an audit had to point out because the first version broke it:
#   * every adb and runner invocation has its exit status checked; a failure aborts the row and the run
#   * a row is usable only with a non-empty reply AND parseable benchmark data
#   * results are keyed by a digest of (prompt, generation settings, runner, model, dispatch library), not
#     by ordinal, because the first version overwrote NN.prompt with a new prompt, printed "cached", and
#     kept the OLD answer and rate -- relabelling a stale result as a fresh one
#   * prompts go to the device as FILES via --input_prompt_file, never interpolated into a remote shell
#     command inside single quotes
#   * partial files never become cache entries: work goes to a temp name and is renamed only on success
set -uo pipefail

ADB=("${ADB:-$HOME/Android/Sdk/platform-tools/adb}")
[ -n "${SERIAL:-}" ] && ADB+=(-s "$SERIAL")      # an ARRAY: "$ADB -s x" would exec a filename with spaces

OUT="${OUT:-/tmp/google-lane}"
RUNNER="${RUNNER:-/data/local/tmp/lm15}"
MODELDIR="${MODELDIR:-/data/local/tmp/enclave-tensor-npu-1}"
MODEL="${MODEL:-$MODELDIR/model.litertlm}"
LIBS="${LIBS:-/data/local/tmp/d15}"
DISPATCH="$MODELDIR/libLiteRtDispatch_GoogleTensor.so"
REMOTE_PROMPT=/data/local/tmp/.glr_prompt.txt
PROMPTS="${1:?usage: $0 prompts.txt}"
mkdir -p "$OUT"

die() { echo "REFUSING: $*" >&2; exit 2; }
sh_() { "${ADB[@]}" shell "$@" < /dev/null; }              # status propagates; stdin never eaten

# ---- preflight: identity of everything that can change an answer -------------------------------------
command -v sha256sum >/dev/null || die "no sha256sum"
for f in "$RUNNER" "$MODEL" "$DISPATCH"; do
  sh_ "[ -f '$f' ]" || die "missing on device: $f"
done
ident() { sh_ "sha256sum '$1' 2>/dev/null | cut -c1-32" | tr -d '\r'; }
R_ID=$(ident "$RUNNER"); M_ID=$(ident "$MODEL"); D_ID=$(ident "$DISPATCH")
[ -n "$R_ID" ] && [ -n "$M_ID" ] && [ -n "$D_ID" ] || die "could not digest runner/model/dispatch"
FMT=$(sh_ "head -c 16 '$MODEL' | xxd -p" | tr -d '\r')
# generation settings: this runner exposes no temperature or token-limit flag, so they are its defaults.
# Recorded explicitly rather than assumed, and part of the cache key so a future flag invalidates it.
SETTINGS="temp=runner-default max_new=runner-default backend=npu"
{
  echo "# google NPU lane, $(date -Is)"
  echo "runner        $RUNNER  sha256:$R_ID"
  echo "model         $MODEL  sha256:$M_ID"
  echo "dispatch      $DISPATCH  sha256:$D_ID"
  echo "litertlm hdr  $FMT   (magic then major/minor LE u32)"
  echo "settings      $SETTINGS"
} > "$OUT/BUILD"
cat "$OUT/BUILD"
KEY_BASE="$R_ID|$M_ID|$D_ID|$SETTINGS"

n=0; used=0; failed=0
mapfile -t PLIST < "$PROMPTS"
for line in "${PLIST[@]}"; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue;; esac
  p="${line%%	*}"
  n=$((n+1)); id=$(printf '%02d' "$n")
  key=$(printf '%s|%s' "$KEY_BASE" "$p" | sha256sum | cut -c1-16)
  base="$OUT/$id.$key"                       # the KEY is in the filename: a different prompt cannot
                                             # inherit this row's answer
  if [ -s "$base.txt" ] && [ -s "$base.rate" ]; then
    echo "[$id] cached ($key)"; used=$((used+1)); continue
  fi
  echo "[$id] $p"
  printf '%s' "$p" > "$OUT/$id.prompt.tmp"
  "${ADB[@]}" push -q "$OUT/$id.prompt.tmp" "$REMOTE_PROMPT" >/dev/null 2>&1 \
    || { echo "  FAILED: could not push the prompt"; failed=$((failed+1)); continue; }
  if ! "${ADB[@]}" shell "cd /data/local/tmp && LD_LIBRARY_PATH=$LIBS timeout 600 $RUNNER \
        --backend=npu --model_path=$MODEL --input_prompt_file=$REMOTE_PROMPT; echo \"__RC__\$?\"" \
        < /dev/null | tr -d '\r' > "$base.raw.tmp"; then
    echo "  FAILED: adb shell returned non-zero"; failed=$((failed+1)); rm -f "$base.raw.tmp"; continue
  fi
  rc=$(grep -oE '^__RC__[0-9]+$' "$base.raw.tmp" | tail -1 | sed 's/__RC__//')
  if [ "${rc:-1}" != "0" ]; then
    echo "  FAILED: runner exited ${rc:-<no status>}"; failed=$((failed+1))
    mv "$base.raw.tmp" "$base.raw.failed"; continue
  fi
  # the reply sits between the echoed prompt and the benchmark block; require BOTH markers
  if ! grep -q '^BenchmarkInfo:' "$base.raw.tmp"; then
    echo "  FAILED: no BenchmarkInfo block, so the run did not complete"; failed=$((failed+1))
    mv "$base.raw.tmp" "$base.raw.failed"; continue
  fi
  awk -v p="input_prompt: $p" 'index($0,p){f=1; sub(/.*input_prompt: /,""); next}
       /^BenchmarkInfo:/{f=0} f' "$base.raw.tmp" | sed '1{/^$/d}' > "$base.txt.tmp"
  grep -oE "Decode Speed: [0-9.]+ tokens/sec" "$base.raw.tmp" | tail -1 > "$base.rate.tmp"
  if [ ! -s "$base.txt.tmp" ] || [ ! -s "$base.rate.tmp" ]; then
    echo "  FAILED: empty reply or no decode rate"; failed=$((failed+1))
    mv "$base.raw.tmp" "$base.raw.failed"; rm -f "$base.txt.tmp" "$base.rate.tmp"; continue
  fi
  mv "$base.raw.tmp" "$base.raw"; mv "$base.txt.tmp" "$base.txt"; mv "$base.rate.tmp" "$base.rate"
  mv "$OUT/$id.prompt.tmp" "$OUT/$id.prompt"
  used=$((used+1))
done
rm -f "$OUT"/*.tmp
sh_ "rm -f $REMOTE_PROMPT" >/dev/null 2>&1
echo
echo "$used usable row(s), $failed failed; results in $OUT"
[ "$failed" -gt 0 ] && exit 1
exit 0
