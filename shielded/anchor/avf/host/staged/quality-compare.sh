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
# A LOCK, taken before anything in $OUT is truncated. BUILD and MANIFEST are opened with > below, so
# two producers sharing an OUT would have one erase the other's record of what it was doing, and
# overwrite the frozen harness the other is executing from. Released on exit; a lock left by a dead pid
# is reclaimed rather than becoming permanent.
LOCK="$OUT/.producer.lock"
if [ -e "$LOCK" ]; then
  other=$(cat "$LOCK" 2>/dev/null)
  case "$other" in ''|*[!0-9]*) echo "REFUSING: $LOCK is unreadable; remove it if no run is in progress" >&2; exit 3;; esac
  if kill -0 "$other" 2>/dev/null; then
    echo "REFUSING: pid $other is already producing into $OUT." >&2
    echo "Two runs sharing an output directory truncate each other's BUILD and MANIFEST." >&2
    exit 3
  fi
  echo "note: reclaiming a stale lock from dead pid $other"
fi
echo $$ > "$LOCK" || { echo "REFUSING: cannot take the lock $LOCK" >&2; exit 3; }
trap 'rm -f "$LOCK"' EXIT
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
# Every identity here was AGGREGATED through a pipeline whose status was thrown away:
#   X=$(printf ... | sha256sum | awk '{print $1}')
# keeps awk's status, not sha256sum's, so a digest command that failed after printing something
# plausible still produced an identity -- the same defect as the per-file digests, one level up. This
# is the only way an identity gets built now: the digest's own status is read, and the result must be
# a usable digest before it is returned.
sha_of() {   # data on stdin -> 64 hex on stdout; nonzero if the digest failed or is unusable
  local out rc
  out=$(sha256sum 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || return 1
  out=${out%% *}
  valid_sha "$out" || return 1
  printf '%s' "$out"
}
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
GRAPHS_ID=$(printf '%s\n' "$GLIST" | sha_of) || { echo "REFUSING: could not form the graphs identity" >&2; exit 3; }
echo "graphs: $GN file(s) digested individually"
# The RUNNERS are part of the identity of a result, and they were not. Applying the thermal/memory fix
# into an existing OUT would otherwise have found every row "cached" and reported logs produced by the
# UNMATCHED runners as a matched run -- the relabelling defect again, now at the level of the harness
# rather than the row. So the runner scripts and the gate they source are digested, and the controlled
# settings are named, and both go into every key.
# Each runner is digested SEPARATELY with its own status checked. Hashing a command group
# ({ sha256sum a; sha256sum b; } | sha256sum) discards every individual status: a missing file, an
# unreadable one, or a sha256sum that printed a plausible digest and exited nonzero all still produced
# a non-empty final hash, which was then accepted as the identity of the harness. Same shape as the
# bundle/graph digest defect, and the empty-input hash before that.
# FREEZE THE HARNESS. This is a shared checkout: a repair committed to host/ while a run is in flight
# changes what the row subprocesses execute, under a key that was fixed before row 01. It happened --
# coolgate.sh was edited mid-run and two rows fall in the window, recorded in that run's directory
# rather than tidied away. A digest captured once cannot prevent it; only not using the live files can.
#
# So the runners are COPIED into $OUT/harness once, digested there, and invoked from there for every
# row. Edits to the checkout after this point cannot reach the run, and the frozen copy is kept beside
# the results as the exact thing that produced them.
RUNNER_FILES="tpu-run.sh local-run.sh coolgate.sh"
# CONTENT-ADDRESSED FREEZE. The first version did `rm -rf $OUT/harness`, destroying the previous run's
# record of what produced it and able to delete a harness another invocation was executing from. And it
# froze only to NAME a directory: the TPU arm still ran ./tpu-run.sh from the live checkout, so a
# mid-run edit still reached it. An independent repro showed exactly that -- row 01 SOURCE=ORIGINAL,
# row 02 SOURCE=EDITED-LIVE, under one captured harness identity.
#
# Copy into a private staging directory, digest the copies BY BASENAME so the identity does not depend
# on where they sit, and publish under $OUT/harness/<RUNNERS_ID>. The same harness lands in the same
# directory and is verified and reused rather than rewritten; a different harness gets its own
# directory and the older one keeps standing beside the rows it produced. Nothing here is deleted.
FROZEN_ROOT="$OUT/harness"; mkdir -p "$FROZEN_ROOT" || { echo "REFUSING: cannot create $FROZEN_ROOT" >&2; exit 3; }
STAGE=$(mktemp -d "$FROZEN_ROOT/.staging.XXXXXXXX") || { echo "REFUSING: cannot stage the harness" >&2; exit 3; }
for rf in $RUNNER_FILES; do
  [ -r "$rf" ] || { rm -rf "$STAGE"; echo "REFUSING: runner '$rf' is missing or unreadable" >&2; exit 3; }
  cp "$rf" "$STAGE/$rf" || { rm -rf "$STAGE"; echo "REFUSING: could not freeze '$rf'" >&2; exit 3; }
done
chmod +x "$STAGE"/*.sh 2>/dev/null
RLIST=""
for rf in $RUNNER_FILES; do
  rout=$( cd "$STAGE" && sha256sum "$rf" 2>/dev/null ); rrc=$?
  [ "$rrc" -eq 0 ] || { rm -rf "$STAGE"; echo "REFUSING: digesting runner '$rf' failed (rc=$rrc)" >&2; exit 3; }
  rdig=$(printf '%s' "$rout" | awk 'NF{print $1; exit}')
  valid_sha "$rdig" || { rm -rf "$STAGE"; echo "REFUSING: runner '$rf' digest is not usable: '${rdig:-<empty>}'" >&2; exit 3; }
  RLIST="$RLIST$rdig  $rf
"
done
RUNNERS_ID=$(printf '%s' "$RLIST" | sort | sha_of) || { rm -rf "$STAGE"; echo "REFUSING: could not form the combined runner identity" >&2; exit 3; }
FROZEN="$FROZEN_ROOT/$RUNNERS_ID"
if [ -d "$FROZEN" ]; then
  for rf in $RUNNER_FILES; do
    cmp -s "$STAGE/$rf" "$FROZEN/$rf" || { rm -rf "$STAGE"
      echo "REFUSING: $FROZEN/$rf does not match the identity naming it; that directory is corrupt" >&2; exit 3; }
  done
  rm -rf "$STAGE"; echo "harness: reusing the verified frozen copy at $FROZEN"
else
  mv "$STAGE" "$FROZEN" || { rm -rf "$STAGE"; echo "REFUSING: could not publish the frozen harness" >&2; exit 3; }
  echo "harness: frozen at $FROZEN"
fi
POLICY="mem=$MEM maxnew=$MAXNEW nocool=${NOCOOL:-0} harness=frozen"
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
  keyfull=$(printf '%s|%s|%s|%s|%s|%s' "$p" "$POLICY" "$GRAPHS_ID" "$BUNDLE_ID" "$RUN_IDENT" "$RUNNERS_ID" | sha_of) \
    || { echo "REFUSING: could not compute the cache key for row $id" >&2; exit 3; }
  key=${keyfull:0:16}
  st_tpu=fail; st_cpu=fail
  for arm in tpu cpu; do
    f="$OUT/$id.$key.$arm.log"
    if [ -s "$f" ] && grep -q "LOCAL done" "$f"; then
      echo "[$id/$arm] cached ($key)"; eval "st_$arm=ok"; continue
    fi
    echo "[$id/$arm] $p"
    rc=0
    if [ "$arm" = tpu ]; then ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 MEM="$MEM" NOCOOL="${NOCOOL:-0}" \
         GRAPHS="${GRAPHS:-tpu/g5-h4ds}" BUNDLE="${BUNDLE:-tpu/lanes-h4ds.etpu}" "$FROZEN/tpu-run.sh" > "$f.tmp" 2>&1 < /dev/null || rc=$?
    else                      ASK="$p" MAXNEW="$MAXNEW" WIDTH=100000 MEM="$MEM" NOCOOL="${NOCOOL:-0}" "$FROZEN/local-run.sh" > "$f.tmp" 2>&1 < /dev/null || rc=$?; fi
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
