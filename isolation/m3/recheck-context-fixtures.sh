#!/bin/sh
# Regression coverage for the RECHECK run context.
#
# The defect this pins: `RECHECK=1 test-m3.sh <workdir>` used to re-score a saved run with whatever happened
# to be in the environment. On a workdir produced under IGVM at VMPL2, a bare invocation fell back to the
# non-IGVM prediction and VMPL0 and reported checks 1 and 3e as FAILURES that were really missing context.
# A re-scorer that guesses is worse than one that refuses, because it invents verdicts in both directions.
#
# So a saved workdir now describes itself in `run-context`, and RECHECK recovers AND verifies it. These
# fixtures check both halves: that a faithful workdir rechecks cleanly with no environment at all, and that
# every way of being unfaithful is refused rather than absorbed.
#
# usage: recheck-context-fixtures.sh <igvm-workdir> <non-igvm-workdir> [scratch]
#   both workdirs must be completed LIVE runs (they supply the evidence; nothing here boots anything)
set -e
here=$(cd "$(dirname "$0")" && pwd)
IW=${1:?usage: recheck-context-fixtures.sh <igvm-workdir> <non-igvm-workdir> [scratch]}
PW=${2:?usage: recheck-context-fixtures.sh <igvm-workdir> <non-igvm-workdir> [scratch]}
# Default the scratch to the same filesystem as the kit rather than /tmp: a workdir carries a ~24 MB image,
# hardlinks only work within a filesystem, and filling the per-user tmpfs quota has killed a shell here before.
S=${3:-$HOME/.cache/enclave-isolation/recheck-ctx-fixtures}; mkdir -p "$S"
fails=0; n=0

# Hardlinked copies: a workdir carries a ~24 MB image and these fixtures only ever mutate run-context.
# Copy the CONTENTS, not the directory: `cp -a src dst` with dst already present nests src inside dst, which
# silently produced clones whose build.txt was one level down and made every positive case "refuse".
clone() {
  d=$S/$1; rm -rf "$d"; mkdir -p "$d"
  cp -al "$2"/. "$d"/ 2>/dev/null || cp -a "$2"/. "$d"/
  echo "$d"
}
ctx_set() { k=$1; v=$2; f=$3; sed -i "s|^$k=.*|$k=$v|" "$f"; }

# run <want:pass|refuse> <description> <workdir> [env assignments...]
run() {
  want=$1; desc=$2; wd=$3; shift 3
  n=$((n + 1))
  if out=$(env RECHECK=1 "$@" "$here/test-m3.sh" "$wd" 2>&1); then got=pass; else
    [ "$?" = 2 ] && got=refuse || got=refuse   # any non-zero is a refusal for our purposes; 2 is the context exit
  fi
  # a "pass" must also be a clean verdict, not merely exit 0
  if [ "$got" = pass ] && ! printf '%s' "$out" | grep -aq '^M3a: ALL PASS'; then got=refuse; fi
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-6s  %s\n' "$got" "$desc"
  else
    printf 'FAIL  %-6s (wanted %s)  %s\n      -> %s\n' "$got" "$want" "$desc" \
      "$(printf '%s' "$out" | grep -aE 'RECHECK|MISMATCH|CONFLICT|^FAIL ' | head -2 | tr '\n' ' ')"
    fails=$((fails + 1))
  fi
}

echo "--- a faithful workdir rechecks with NO environment at all (the independent-style invocation)"
run pass   "IGVM workdir, bare RECHECK=1"        "$(clone ok-igvm "$IW")"
run pass   "non-IGVM workdir, bare RECHECK=1"    "$(clone ok-plain "$PW")"

echo "--- a workdir that cannot say what produced it is refused, not guessed at"
d=$(clone no-ctx "$IW"); rm -f "$d/run-context"
run refuse "run-context missing entirely"        "$d"

echo "--- tamper evidence: the tools that decided a digest must still be those tools"
d=$(clone bad-igvm-sha "$IW"); ctx_set CTX_IGVM_SHA 0000000000000000000000000000000000000000000000000000000000000000 "$d/run-context"
run refuse "IGVM hash does not match the record"  "$d"
d=$(clone bad-meas-sha "$IW"); ctx_set CTX_IGVMMEASURE_SHA deadbeef00000000000000000000000000000000000000000000000000000000 "$d/run-context"
run refuse "igvmmeasure hash does not match"      "$d"
d=$(clone bad-qemu-sha "$IW"); ctx_set CTX_QEMU_SHA deadbeef00000000000000000000000000000000000000000000000000000000 "$d/run-context"
run refuse "QEMU hash does not match"             "$d"
d=$(clone gone-igvm "$IW"); ctx_set CTX_IGVM /nonexistent/coconut.igvm "$d/run-context"
run refuse "the recorded IGVM no longer exists"   "$d"

echo "--- the recorded digest must re-derive from the recorded inputs"
d=$(clone bad-derived "$IW"); ctx_set CTX_DERIVED_MEAS aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999dddd0000eeee1111ffff2222 "$d/run-context"
run refuse "recorded derived digest is not what re-deriving gives" "$d"
d=$(clone bad-want "$IW"); ctx_set CTX_WANT_MEAS aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999dddd0000eeee1111ffff2222 "$d/run-context"
run refuse "recorded expected digest disagrees"   "$d"

echo "--- a caller that contradicts the record is refused rather than silently overriding it"
run refuse "VMPL passed that the run did not use"  "$(clone conflict-vmpl "$IW")"  VMPL=0
run refuse "IGVM passed that the run did not use"  "$(clone conflict-igvm "$IW")"  IGVM=/some/other.igvm
run refuse "EXPECT_MEAS passed on a derived run"   "$(clone conflict-exp "$IW")"   EXPECT_MEAS=abc123
echo "--- but naming the SAME values the run recorded is fine"
ctxv() { sed -n "s/^$1=//p" "$2"; }
iw_vmpl=$(ctxv CTX_VMPL "$IW/run-context"); iw_igvm=$(ctxv CTX_IGVM "$IW/run-context")
run pass   "VMPL and IGVM passed, matching the record" "$(clone agree "$IW")" VMPL="$iw_vmpl" IGVM="$iw_igvm"

printf '\n'
if [ "$fails" -eq 0 ]; then
  echo "recheck context fixtures: ALL $n PASS (scratch $S)"
else
  echo "recheck context fixtures: $fails of $n FAILED (scratch $S)"
  exit 1
fi
