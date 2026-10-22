#!/bin/bash
# Mutation controls: each mutant of network/lease-gas-owner.mjs is placed in negctl/ (a mirror whose other imports are
# symlinks to work/enclave) and the two focused suites run against it; every mutant must FAIL. Nothing in work/enclave
# is written. "orig" is the pre-change module (expected: import of the new API fails = not a meaningful kill, recorded).
cd "$(dirname "$0")/negctl" || exit 2
SRC=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/network/lease-gas-owner.mjs
declare -A M
M[M1-free-uses-paid-rule]='s/c.renewLeadSec = lead; c.freeCycleSec = L - lead;/c.renewLeadSec = lead; c.freeCycleSec = L;/'
M[M2-unknown-counted-as-paid]='s/else if (c.freeCycleSec <= ext) Object.assign/else if (false) Object.assign/'
M[M3-default-lead-zero]='s/else if (win !== null) { lead = win;/else if (win !== null) { lead = 0;/'
M[M4-unknown-max-dropped]='s/return counts.reduce((m, x) => (x > m ? x : m));/return counts[0];/'
M[M5-window-boundary-off-by-one]='s/if (win !== null \&\& lead > win)/if (win !== null \&\& lead >= win)/'
fail=0
for k in $(printf '%s\n' "${!M[@]}" | sort); do
  sed "${M[$k]}" "$SRC" > network/lease-gas-owner.mjs
  if cmp -s "$SRC" network/lease-gas-owner.mjs; then echo "== $k: MUTATION DID NOT APPLY"; fail=1; continue; fi
  node --test test/lease-gas-cost-model.test.mjs test/lease-gas-cost-model-ledger.test.mjs > "../rawlogs/mutant-$k.tap" 2>&1; rc=$?
  echo "== $k: rc=$rc $(grep -E '^# (pass|fail) ' ../rawlogs/mutant-$k.tap | tr '\n' ' ') failing: $(grep -E '^not ok' ../rawlogs/mutant-$k.tap | sed 's/^not ok [0-9]* - //' | cut -c1-60 | tr '\n' '|')"
  [ $rc -eq 0 ] && { echo "   SURVIVED"; fail=1; }
done
cp "$SRC" network/lease-gas-owner.mjs
node --test test/lease-gas-cost-model.test.mjs test/lease-gas-cost-model-ledger.test.mjs > ../rawlogs/mutant-none.tap 2>&1; echo "== unmutated mirror: rc=$? $(grep -E '^# (pass|fail) ' ../rawlogs/mutant-none.tap | tr '\n' ' ')"
exit $fail
