#!/bin/bash
# refusal cases of build-approved.sh, each from its own copy (own APPROVED-COMMIT.txt); every case must exit 2 BEFORE any build
cd "$(dirname "$0")"; fail=0
case_() { n=$1; want=$2; shift 2; mkdir -p c$n; cp ../build-approved.sh c$n/; [ $# -gt 0 ] && printf '%s\n' "$@" > c$n/APPROVED-COMMIT.txt
  out=$(bash c$n/build-approved.sh 2>&1); rc=$?
  if [ $rc = 2 ] && grep -q "$want" <<<"$out" && [ ! -e c$n/stage-approved ]; then echo "OK   $n: $out"; else echo "FAIL $n rc=$rc: $out"; fail=1; fi; }
case_ 1 'no APPROVED-COMMIT'
case_ 2 'no 40-hex' 'commit a6b1378' 'extra NONE'
case_ 3 'must state extra' 'commit a6b1378cdf430217025987d90c040d0e25a9993d'
case_ 4 'not in H' 'commit 0000000000000000000000000000000000000000' 'extra NONE'
case_ 5 'does not descend' 'commit deabf8f90f64902d20d48620fd911d34c445859d' 'extra NONE'
case_ 6 'changes no image file' 'commit a6b1378cdf430217025987d90c040d0e25a9993d' 'extra NONE'
exit $fail
