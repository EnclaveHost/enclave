#!/usr/bin/env bash
# quality-compare.sh -- the masked TPU decode against the unmasked CPU decode of the SAME GGUF, under matched controls.
#
# What this can and cannot prove. The CPU arm is NOT a bit-exact oracle: it dequantises the GGUF and accumulates in
# f32, while the TPU arm sends int8 digits of a modularly masked row and requantises the returned products. The two
# are different arithmetic by construction, so the question is never equality, it is how far the masked path drifts.
# It is also not Google's NPU lane: that is a different model package (LiteRT-LM, its own quantisation and tokenizer)
# and no token-level comparison against it is possible from here. What this isolates is exactly the thing the lane
# design adds -- masking, offload, digit-split, requantisation -- with everything else held identical.
#
# The controls the audit required, all of them here rather than assumed:
#   equal token limits (MAXNEW passed to BOTH arms; local-run.sh ignored it until this was fixed)
#   identical input (ONE turn per run, so no arm ever conditions on a history the other did not have)
#   greedy (temp_milli defaults to 0) so a difference is the arithmetic and not the sampler
#   untruncated output (WIDTH raised; the default 260 silently cut A: lines in the earlier comparison)
#   no drafter in either arm, so speculative batch shapes cannot enter the comparison
#
# Greedy decoding compounds: one flipped argmax changes every token after it. So the measure reported is the
# position of the FIRST divergence, not a per-token agreement rate, and the full text of both arms is kept.
#
#   OUT=/tmp/q MAXNEW=48 ./quality-compare.sh prompts.txt
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; [ -n "${SERIAL:-}" ] && ADB="$ADB -s $SERIAL"
OUT="${OUT:-/tmp/quality-compare}"; MAXNEW="${MAXNEW:-48}"; mkdir -p "$OUT"
# BUILD IDENTITY, recorded rather than assumed. Fault-injection experiments run the same source tree with a
# different constant, and a filename never proved which binary answered: the digests below and the payload's
# own "tpu: config" line (which prints repair/verify/inject as COMPILED) are what tie a result to a build.
: > "$OUT/BUILD"
# Binary identity is established by build-identity.sh, which pulls the installed APK to a seekable file
# and checks every step. The inline pipeline that used to live here recorded the SHA256 of ZERO BYTES as
# the installed digest, because unzip cannot extract a member from a stream and nothing checked a status.
if ! "$HERE/build-identity.sh" "$OUT/BUILD"; then
  echo "REFUSING to run: the binary that would produce these results cannot be identified." >&2
  cat "$OUT/BUILD" >&2
  exit 3
fi
cat "$OUT/BUILD"
# the binary that will produce these rows, folded into every cache key
RUN_IDENT=$(grep -oE '^[a-z-]+\.so sha256  [0-9a-f]+' "$OUT/BUILD" | head -1 | awk '{print $3}')
[ -n "$RUN_IDENT" ] || RUN_IDENT="unknown-binary"
PROMPTS="${1:-}"; [ -n "$PROMPTS" ] || { echo "usage: $0 prompts.txt"; exit 2; }
# The prompt list is read into an ARRAY first. Reading it with `while read < file` and running adb inside the
# loop silently ran ONE prompt and stopped: adb consumes stdin, so it ate the rest of the file.
mapfile -t PLIST < "$PROMPTS"
n=0
for p in "${PLIST[@]}"; do
  [ -z "$p" ] && continue
  case "$p" in \#*) continue;; esac
  # a line is "prompt<TAB>expectation"; the expectation is scored by quality-report.py, not here
  want="${p#*	}"; [ "$want" = "$p" ] && want=""
  p="${p%%	*}"
  n=$((n+1)); id=$(printf '%02d' "$n")
  # The cache key binds the prompt to the SETTINGS and the BINARY, because keying by ordinal alone let a
  # changed prompt inherit the previous prompt's log: the old loop wrote NN.prompt first, then saw a
  # non-empty NN.tpu.log and reported "already have", so an answer to a different question was relabelled
  # as this one's. Same defect an audit found in google-lane-run.sh.
  key=$(printf '%s|%s|%s|%s|%s' "$p" "$MAXNEW" "${GRAPHS:-tpu/g5-h4ds}" "${BUNDLE:-tpu/lanes-h4ds.etpu}" \
        "$RUN_IDENT" | sha256sum | cut -c1-16)
  for arm in tpu cpu; do
    f="$OUT/$id.$key.$arm.log"
    if [ -s "$f" ] && grep -q "LOCAL done" "$f"; then
      echo "[$id/$arm] cached ($key)"; continue        # only a COMPLETE run is a cache hit
    fi
    echo "[$id/$arm] $p"
    if [ "$arm" = tpu ]; then ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 \
         GRAPHS="${GRAPHS:-tpu/g5-h4ds}" BUNDLE="${BUNDLE:-tpu/lanes-h4ds.etpu}" ./tpu-run.sh > "$f.tmp" 2>&1 < /dev/null
    else                      ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 NOCOOL="${NOCOOL:-0}" ./local-run.sh > "$f.tmp" 2>&1 < /dev/null; fi
    if grep -q "LOCAL done" "$f.tmp"; then
      mv "$f.tmp" "$f"                                  # renamed only when the run completed
    else
      mv "$f.tmp" "$f.failed"
      echo "   FAILED (no LOCAL done): kept as $(basename "$f").failed"
    fi
  done
  # written only AFTER the arms, so a half-finished row cannot leave a prompt label with no result
  printf '%s\n' "$p" > "$OUT/$id.prompt"
  printf '%s\n' "$want" > "$OUT/$id.expect"
done
echo; echo "runs in $OUT; compare with: python3 $(pwd)/quality-report.py $OUT"
