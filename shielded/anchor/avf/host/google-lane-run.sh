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

# Same thermal gate as the two in-VM arms, and for the same reason: this lane's decode rate is being
# compared against theirs, and a rate from a hot or capped phone is not a comparable measurement. It
# refuses rather than falling through; NOCOOL=1 bypasses it, says so, and is folded into the key.
. "$(cd "$(dirname "$0")" && pwd)/coolgate.sh"
ADB_SAVE="${ADB[*]}"; ADB="${ADB[*]}"          # coolgate.sh uses $ADB as a word-split string
cool_gate || die "the phone is not in a comparable thermal state"
ADB=("${ADB_SAVE}")
mkdir -p "$OUT"

die() { echo "REFUSING: $*" >&2; exit 2; }

# Run a remote command and propagate its REAL status. `adb shell` has historically returned 0 whatever
# the remote command did, and a remote pipeline like `sha256sum x | cut -c1-32` returns the status of
# `cut`, which succeeds on empty input -- so an audit produced a device that printed a valid-looking
# digest and exited 42 while this harness reported a usable row. The status comes back explicitly.
sh_out() {
    local raw trc rc
    # TWO statuses matter and they are independent: adb's own (the transport) and the remote command's.
    # An audit built a device that printed a valid 64-hex digest and __RC__0 while adb ITSELF exited 42,
    # and this accepted the row -- because the pipe to tr made the substitution report tr's status.
    # So: no pipeline here, and the transport status is checked before the marker is believed.
    raw=$("${ADB[@]}" shell "$* ; echo __RC__\$?" < /dev/null 2>/dev/null); trc=$?
    if [ "$trc" -ne 0 ]; then return 126; fi                 # the transport failed
    raw=$(printf '%s' "$raw" | tr -d '\r')
    rc=$(printf '%s\n' "$raw" | sed -n 's/^__RC__\([0-9][0-9]*\)$/\1/p' | tail -1)
    printf '%s\n' "$raw" | sed '/^__RC__[0-9][0-9]*$/d'
    [ -n "$rc" ] || return 125          # no status marker at all: the remote shell never ran our command
    return "$rc"
}
sh_() { sh_out "$@" >/dev/null; }

# ---- preflight: identity of everything that can change an answer -------------------------------------
command -v sha256sum >/dev/null || die "no sha256sum"
for f in "$RUNNER" "$MODEL" "$DISPATCH"; do
  sh_ "[ -f '$f' ]" || die "missing on device: $f"
done
# no remote pipeline: sha256sum alone, its status checked, and the DIGEST FORMAT validated locally
ident() {
    local out d
    out=$(sh_out "sha256sum '$1'") || return 1
    d=$(printf '%s\n' "$out" | head -1 | awk '{print $1}')
    printf '%s' "$d" | grep -qE '^[0-9a-f]{64}$' || return 1
    printf '%s' "${d:0:32}"
}
R_ID=$(ident "$RUNNER")   || die "could not digest the runner ($RUNNER)"
M_ID=$(ident "$MODEL")    || die "could not digest the model ($MODEL)"
D_ID=$(ident "$DISPATCH") || die "could not digest the dispatch library ($DISPATCH)"
FMT=$(sh_out "head -c 16 '$MODEL' | xxd -p") || die "could not read the .litertlm header"
FMT=$(printf '%s' "$FMT" | tr -d ' \n')
printf '%s' "$FMT" | grep -qE '^4c49544552544c4d[0-9a-f]{16}$' \
    || die "the model does not begin with the LITERTLM magic (got '${FMT:0:32}')"
# GENERATION SETTINGS. The runner Google ships (litert_lm_main at 4698342e) exposes only --backend,
# --model_path, --input_prompt and --input_prompt_file: verified with --helpfull on the device, not
# assumed. So this lane could only ever run at whatever the .litertlm package declares, while the masked
# and CPU lanes decode greedily -- a confound in any task comparison between them, since a difference
# could be the sampler rather than the lane.
#
# SAMPLER=greedy requires a runner built with the local patch (RUNNER=/data/local/tmp/lm15s), which adds
# --sampler and --temperature and prints the package's declared sampler. Its DEFAULT is --sampler=model,
# which is the shipped behaviour unchanged. The runner digest is already in the key, so results from the
# patched and unpatched binaries can never be confused for each other.
SAMPLER="${SAMPLER:-model}"
case "$SAMPLER" in model|greedy) ;; *) die "SAMPLER must be model or greedy, got '$SAMPLER'";; esac
SAMPLER_FLAG=""
if [ "$SAMPLER" != model ]; then
  # Capture first, THEN grep. Piping adb into `grep -q` makes grep exit on the first match, adb take
  # SIGPIPE, and `set -o pipefail` report 141 -- so a runner that DOES expose the flag was rejected
  # for having answered too well.
  # --helpfull exits NON-ZERO (absl prints help and returns 1), so its status says nothing about
  # whether the flag exists. The text does. A runner that is missing or will not start prints nothing
  # and fails the grep, which is the same refusal by a different route.
  helptxt=$("${ADB[@]}" shell "LD_LIBRARY_PATH=$LIBS $RUNNER --helpfull 2>&1" < /dev/null 2>/dev/null || true)
  printf '%s' "$helptxt" | grep -q -- '--sampler' \
    || die "SAMPLER=$SAMPLER needs a runner that exposes --sampler; $RUNNER does not (use lm15s)"
  SAMPLER_FLAG="--sampler=$SAMPLER"
  [ -n "${TEMPERATURE:-}" ] && SAMPLER_FLAG="$SAMPLER_FLAG --temperature=$TEMPERATURE"
fi
SETTINGS="sampler=$SAMPLER${TEMPERATURE:+ temp=$TEMPERATURE} max_new=runner-default backend=npu nocool=${NOCOOL:-0}"
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

[ -r "$PROMPTS" ] || die "cannot read the prompt list '$PROMPTS'"
mapfile -t PLIST < "$PROMPTS"
# Same contract as quality-compare.sh, and for the same reason: a reader must never have to guess which
# artifact belongs to which row, and a run cut short must not shrink the denominator into a flattering
# score. The expected count is fixed BEFORE any row runs.
EXPECT_ROWS=0
for line in "${PLIST[@]}"; do [ -z "$line" ] && continue; case "$line" in \#*) continue;; esac; EXPECT_ROWS=$((EXPECT_ROWS+1)); done
[ "$EXPECT_ROWS" -gt 0 ] || die "'$PROMPTS' contains no prompts"
MANIFEST="$OUT/MANIFEST.tsv"
{ printf '# expect_rows\t%s\n' "$EXPECT_ROWS"; printf '# id\tkey\tnpu\tprompt\texpect\n'; } > "$MANIFEST"
n=0; used=0; failed=0
for line in "${PLIST[@]}"; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue;; esac
  p="${line%%	*}"
  want="${line#*	}"; [ "$want" = "$line" ] && want=""
  n=$((n+1)); id=$(printf '%02d' "$n")
  row() { printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$key" "$1" "$p" "$want" >> "$MANIFEST"; }
  # the digest's own status, not cut's: see quality-compare.sh's sha_of for the defect this closes
  keyraw=$(printf '%s|%s' "$KEY_BASE" "$p" | sha256sum 2>/dev/null) \
    || die "could not compute the cache key for row $id"
  keyfull=${keyraw%% *}
  case "$keyfull" in *[!0-9a-f]*|"") die "cache key digest is not usable: '${keyfull:-<empty>}'";; esac
  [ ${#keyfull} -eq 64 ] || die "cache key digest is the wrong length"
  key=${keyfull:0:16}
  base="$OUT/$id.$key"                       # the KEY is in the filename: a different prompt cannot
                                             # inherit this row's answer
  if [ -s "$base.txt" ] && [ -s "$base.rate" ]; then
    echo "[$id] cached ($key)"; used=$((used+1)); row ok; continue
  fi
  echo "[$id] $p"
  printf '%s' "$p" > "$OUT/$id.prompt.tmp"
  "${ADB[@]}" push -q "$OUT/$id.prompt.tmp" "$REMOTE_PROMPT" >/dev/null 2>&1 \
    || { echo "  FAILED: could not push the prompt"; failed=$((failed+1)); row push-failed; continue; }
  if ! "${ADB[@]}" shell "cd /data/local/tmp && LD_LIBRARY_PATH=$LIBS timeout 600 $RUNNER \
        --backend=npu --model_path=$MODEL --input_prompt_file=$REMOTE_PROMPT $SAMPLER_FLAG; echo \"__RC__\$?\"" \
        < /dev/null | tr -d '\r' > "$base.raw.tmp"; then
    echo "  FAILED: adb shell returned non-zero"; failed=$((failed+1)); row transport-failed; rm -f "$base.raw.tmp"; continue
  fi
  rc=$(grep -oE '^__RC__[0-9]+$' "$base.raw.tmp" | tail -1 | sed 's/__RC__//')
  if [ "${rc:-1}" != "0" ]; then
    echo "  FAILED: runner exited ${rc:-<no status>}"; failed=$((failed+1)); row runner-failed
    mv "$base.raw.tmp" "$base.raw.failed"; continue
  fi
  # the reply sits between the echoed prompt and the benchmark block; require BOTH markers
  if ! grep -q '^BenchmarkInfo:' "$base.raw.tmp"; then
    echo "  FAILED: no BenchmarkInfo block, so the run did not complete"; failed=$((failed+1)); row incomplete
    mv "$base.raw.tmp" "$base.raw.failed"; continue
  fi
  awk -v p="input_prompt: $p" 'index($0,p){f=1; sub(/.*input_prompt: /,""); next}
       /^BenchmarkInfo:/{f=0} f' "$base.raw.tmp" | sed '1{/^$/d}' > "$base.txt.tmp"
  grep -oE "Decode Speed: [0-9.]+ tokens/sec" "$base.raw.tmp" | tail -1 > "$base.rate.tmp"
  if [ ! -s "$base.txt.tmp" ] || [ ! -s "$base.rate.tmp" ]; then
    echo "  FAILED: empty reply or no decode rate"; failed=$((failed+1)); row empty-reply
    mv "$base.raw.tmp" "$base.raw.failed"; rm -f "$base.txt.tmp" "$base.rate.tmp"; continue
  fi
  mv "$base.raw.tmp" "$base.raw"; mv "$base.txt.tmp" "$base.txt"; mv "$base.rate.tmp" "$base.rate"
  mv "$OUT/$id.prompt.tmp" "$OUT/$id.prompt"
  used=$((used+1)); row ok
done
rm -f "$OUT"/*.tmp
sh_ "rm -f $REMOTE_PROMPT" >/dev/null 2>&1
echo
echo "$used usable row(s), $failed failed; results in $OUT"
[ "$failed" -gt 0 ] && exit 1
exit 0
