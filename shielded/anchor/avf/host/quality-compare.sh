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
cd "$(dirname "$0")"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; [ -n "${SERIAL:-}" ] && ADB="$ADB -s $SERIAL"
OUT="${OUT:-/tmp/quality-compare}"; MAXNEW="${MAXNEW:-48}"; mkdir -p "$OUT"
# BUILD IDENTITY, recorded rather than assumed. Fault-injection experiments run the same source tree with a
# different constant, and a filename never proved which binary answered: the digests below and the payload's
# own "tpu: config" line (which prints repair/verify/inject as COMPILED) are what tie a result to a build.
: > "$OUT/BUILD"
# The authority is the APK the DEVICE has, not what is lying in out/. An earlier version of this recorded
# out/attest_probe.apk -- a target that was never installed -- next to results produced by out/anchor.apk,
# and separately TPU.md quoted a staged sha taken BEFORE the rebuild, which was the fault-injection build.
# So: pull the installed path from the package manager and digest the library inside it.
APKPATH=$($ADB shell pm path host.enclave.anchor.avf 2>/dev/null | sed 's/^package://' | tr -d '\r' | head -1)
if [ -n "$APKPATH" ]; then
  printf 'installed apk  %s\n' "$APKPATH" >> "$OUT/BUILD"
  printf '%s  libggml-tpu.so (FROM THE INSTALLED APK)\n' \
    "$($ADB shell "cat $APKPATH" < /dev/null 2>/dev/null | unzip -p /dev/stdin lib/arm64-v8a/libggml-tpu.so 2>/dev/null | sha256sum | cut -c1-32)" >> "$OUT/BUILD"
fi
for f in ../out/anchor.apk; do
  [ -f "$f" ] && printf '%s  %s (local, for comparison only)\n' "$(sha256sum "$f" | cut -c1-32)" "${f##*/}" >> "$OUT/BUILD"
  [ -f "$f" ] && printf '%s  libggml-tpu.so inside that local apk\n' "$(unzip -p "$f" lib/arm64-v8a/libggml-tpu.so 2>/dev/null | sha256sum | cut -c1-32)" >> "$OUT/BUILD"
done
grep -n 'kRepairClips\|kVerifyKernel\|kInjectFault' ../payload/ggml-tpu.cpp | grep 'constexpr' >> "$OUT/BUILD"
cat "$OUT/BUILD"
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
  printf '%s\n' "$p" > "$OUT/$id.prompt"
  printf '%s\n' "$want" > "$OUT/$id.expect"
  for arm in tpu cpu; do
    f="$OUT/$id.$arm.log"
    [ -s "$f" ] && { echo "[$id/$arm] already have $f"; continue; }
    echo "[$id/$arm] $p"
    if [ "$arm" = tpu ]; then ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 \
         GRAPHS="${GRAPHS:-tpu/g5-h4ds}" BUNDLE="${BUNDLE:-tpu/lanes-h4ds.etpu}" ./tpu-run.sh > "$f" 2>&1 < /dev/null
    else                      ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 NOCOOL="${NOCOOL:-0}" ./local-run.sh > "$f" 2>&1 < /dev/null; fi
    grep -c "LOCAL done" "$f" >/dev/null || echo "   (no LOCAL done -- see $f)"
  done
done
echo; echo "runs in $OUT; compare with: python3 $(pwd)/quality-report.py $OUT"
