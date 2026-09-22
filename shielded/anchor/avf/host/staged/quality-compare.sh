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
ADB=("${ADB:-$HOME/Android/Sdk/platform-tools/adb}"); [ -n "${SERIAL:-}" ] && ADB+=(-s "$SERIAL")
OUT="${OUT:-/tmp/quality-compare}"; MAXNEW="${MAXNEW:-48}"; MEM="${MEM:-8192}"; mkdir -p "$OUT"
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
[ -n "$RUN_IDENT" ] || { echo "REFUSING: no library digest in $OUT/BUILD; an unknown binary is not an identity" >&2; exit 3; }
# The bundle and graphs are keyed by CONTENT, not by path: the same path can hold different bytes.
F_DIR=/data/user/0/host.enclave.anchor.avf/files
# Digesting the artifacts is itself an evidence path, and it had the SAME defect twice fixed elsewhere:
# the command status was never read, so anything that printed 64 hex characters was accepted as an
# identity. Three ways that produces a confident wrong answer:
#   - adb exits nonzero (device gone, run-as denied) having already printed something plausible;
#   - the remote command fails but the pipeline's LAST stage succeeds -- `cat missing/*.tflite | sha256sum`
#     hashes EMPTY INPUT and returns e3b0c442..., which is a valid-looking digest of nothing, the exact
#     shape of the bug that once recorded the SHA256 of zero bytes as the installed binary's identity;
#   - a concatenation hides the file list, so one graph missing, renamed or reordered can hash the same.
# So: both statuses are checked, the digest must be 64 hex and must not be the empty-input hash, the
# graph list must be non-empty and readable, and the graphs identity is the hash of a SORTED list of
# per-file digests and names rather than of a concatenated byte stream.
SHA_EMPTY=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
dev_run() {   # dev_run '<remote sh script>' -> stdout; nonzero if EITHER the transport or the remote failed
  local out rc rrc
  out=$("${ADB[@]}" shell "run-as host.enclave.anchor.avf sh -c '$1'; echo __RC__\$?" < /dev/null 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then echo "adb transport failed (rc=$rc)" >&2; return 1; fi
  out=$(printf '%s' "$out" | tr -d '\r')
  rrc=$(printf '%s\n' "$out" | sed -n 's/^__RC__\([0-9][0-9]*\)$/\1/p' | tail -1)
  if [ -z "$rrc" ]; then echo "no remote status marker in the reply" >&2; return 1; fi
  if [ "$rrc" -ne 0 ]; then echo "remote command failed (rc=$rrc)" >&2; return 1; fi
  printf '%s\n' "$out" | sed '/^__RC__[0-9][0-9]*$/d'
}
valid_sha() { case "$1" in *[!0-9a-f]*|"") return 1;; esac; [ ${#1} -eq 64 ] && [ "$1" != "$SHA_EMPTY" ]; }
BPATH="$F_DIR/${BUNDLE:-tpu/lanes-h4ds.etpu}"; GPATH="$F_DIR/${GRAPHS:-tpu/g5-h4ds}"
raw=$(dev_run "sha256sum \"$BPATH\"") || { echo "REFUSING: could not digest the bundle on the device" >&2; exit 3; }
BUNDLE_ID=$(printf '%s\n' "$raw" | awk 'NF{print $1; exit}')
valid_sha "$BUNDLE_ID" || { echo "REFUSING: bundle digest is not a usable identity: '${BUNDLE_ID:-<empty>}'" >&2; exit 3; }
# per-file digests, so a missing or renamed graph cannot hash the same as a complete set
raw=$(dev_run "cd \"$GPATH\" && sha256sum *.tflite") || { echo "REFUSING: could not list/digest the graphs on the device" >&2; exit 3; }
GLIST=$(printf '%s\n' "$raw" | awk 'NF>=2 {print $1"  "$2}' | sort)
GN=$(printf '%s\n' "$GLIST" | grep -c . || true)
[ "${GN:-0}" -ge 1 ] || { echo "REFUSING: no readable .tflite graphs at $GPATH" >&2; exit 3; }
while read -r d _; do valid_sha "$d" || { echo "REFUSING: bad per-graph digest '$d'" >&2; exit 3; }; done <<< "$GLIST"
GRAPHS_ID=$(printf '%s\n' "$GLIST" | sha256sum | awk '{print $1}')
valid_sha "$GRAPHS_ID" || { echo "REFUSING: graphs identity is not usable" >&2; exit 3; }
echo "graphs: $GN file(s) digested individually"
# The RUNNERS are part of the identity of a result, and they were not. Applying the thermal/memory fix
# into an existing OUT would otherwise have found every row "cached" and reported logs produced by the
# UNMATCHED runners as a matched run -- the relabelling defect again, now at the level of the harness
# rather than the row. So the runner scripts and the gate they source are digested, and the controlled
# settings are named, and both go into every key.
RUNNERS_ID=$( { sha256sum tpu-run.sh; sha256sum local-run.sh; sha256sum coolgate.sh; } | sort | sha256sum | awk '{print $1}')
[ -n "$RUNNERS_ID" ] || { echo "REFUSING: could not digest the arm runners" >&2; exit 3; }
POLICY="mem=$MEM maxnew=$MAXNEW nocool=${NOCOOL:-0}"
{ echo "bundle sha256  $BUNDLE_ID"; echo "graphs sha256  $GRAPHS_ID"
  echo "runners sha256 $RUNNERS_ID  (tpu-run.sh + local-run.sh + coolgate.sh)"
  echo "settings       $POLICY"
  [ "${NOCOOL:-0}" = 1 ] && echo "WARNING        NOCOOL=1: the thermal gate was BYPASSED; these rates are not controlled"
} >> "$OUT/BUILD"
PROMPTS="${1:-}"; [ -n "$PROMPTS" ] || { echo "usage: $0 prompts.txt"; exit 2; }
# This script cd's to its own directory, so a RELATIVE prompts path given from elsewhere silently
# resolves to nothing. mapfile then leaves PLIST empty, the loop runs zero times, and the script
# reports "0 failed arm(s)" and exits 0 -- a confident empty success, the same shape as every other
# unchecked-input defect in this tree. An unreadable prompt list is a refusal.
[ -r "$PROMPTS" ] || { echo "REFUSING: cannot read the prompt list '$PROMPTS' (this script runs from $HERE, so give an absolute path)" >&2; exit 2; }
# The prompt list is read into an ARRAY first. Reading it with `while read < file` and running adb inside the
# loop silently ran ONE prompt and stopped: adb consumes stdin, so it ate the rest of the file.
mapfile -t PLIST < "$PROMPTS"
# The DENOMINATOR is fixed before any row runs. A manifest is written row by row, so a run that is
# interrupted -- or that dies on row 3 of 8 -- leaves a SHORT manifest, and a reader that scores only the
# rows it finds turns an abandoned run into a flattering 2/2. The expected count is declared up front and
# the report scores against it, counting anything missing as a failure.
EXPECT_ROWS=0
for p in "${PLIST[@]}"; do [ -z "$p" ] && continue; case "$p" in \#*) continue;; esac; EXPECT_ROWS=$((EXPECT_ROWS+1)); done
[ "$EXPECT_ROWS" -gt 0 ] || { echo "REFUSING: '$PROMPTS' contains no prompts" >&2; exit 2; }
MANIFEST="$OUT/MANIFEST.tsv"
{ printf '# expect_rows\t%s\n' "$EXPECT_ROWS"
  printf '# settings\t%s\n' "$POLICY"
  printf '# runners\t%s\n' "$RUNNERS_ID"
  printf '# binary\t%s\n' "$RUN_IDENT"
  printf '# id\tkey\ttpu\tcpu\tprompt\texpect\n'; } > "$MANIFEST"
n=0; failed=0
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
  # settings AND runner identity in the key: a different MEM, a different token budget, or a bypassed
  # thermal gate is a different experiment, and must re-run rather than be served from cache.
  key=$(printf '%s|%s|%s|%s|%s|%s' "$p" "$POLICY" "$GRAPHS_ID" "$BUNDLE_ID" "$RUN_IDENT" "$RUNNERS_ID" | sha256sum | cut -c1-16)
  st_tpu=fail; st_cpu=fail
  for arm in tpu cpu; do
    f="$OUT/$id.$key.$arm.log"
    if [ -s "$f" ] && grep -q "LOCAL done" "$f"; then
      echo "[$id/$arm] cached ($key)"; eval "st_$arm=ok"; continue
    fi
    echo "[$id/$arm] $p"
    rc=0
    if [ "$arm" = tpu ]; then ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 MEM="$MEM" NOCOOL="${NOCOOL:-0}" \
         GRAPHS="${GRAPHS:-tpu/g5-h4ds}" BUNDLE="${BUNDLE:-tpu/lanes-h4ds.etpu}" ./tpu-run.sh > "$f.tmp" 2>&1 < /dev/null || rc=$?
    else                      ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 MEM="$MEM" NOCOOL="${NOCOOL:-0}" ./local-run.sh > "$f.tmp" 2>&1 < /dev/null || rc=$?; fi
    # BOTH must hold: the producer exited cleanly AND the run reached its completion marker
    if [ "$rc" -eq 0 ] && grep -q "LOCAL done" "$f.tmp"; then
      mv "$f.tmp" "$f"; eval "st_$arm=ok"
    else
      mv "$f.tmp" "$f.failed"
      echo "   FAILED (rc=$rc, LOCAL done: $(grep -qc 'LOCAL done' "$f.failed" 2>/dev/null && echo yes || echo no)): kept as $(basename "$f").failed"
      failed=$((failed+1))
    fi
  done
  # The MANIFEST is the only thing a reader should trust: it binds this id and key to this prompt, these
  # settings and this binary, with a per-arm status. quality-report.py used to glob NN.*.arm.log and take
  # the lexicographically last hash, which let an OLD log for a DIFFERENT prompt be scored as this row --
  # a false PASS. There is nothing to guess from any more.
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$key" "$st_tpu" "$st_cpu" "$p" "$want" >> "$MANIFEST"
done
echo; echo "runs in $OUT ($failed failed arm(s)); compare with: python3 $(pwd)/quality-report.py $OUT"
exit $(( failed > 0 ? 1 : 0 ))
