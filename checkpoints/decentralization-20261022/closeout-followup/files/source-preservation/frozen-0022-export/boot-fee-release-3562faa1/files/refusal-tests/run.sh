#!/bin/bash
# build-price.sh refusals, each from its own copy (own APPROVED-COMMIT.txt), against H's REAL repo; every case must exit 2
# before any build (no stage/ dir created).
cd "$(dirname "$0")"; fail=0
case_() { n=$1; want=$2; shift 2; mkdir -p c$n; cp ../build-price.sh ../precheck.py ../entries.py ../verify.py c$n/
  [ $# -gt 0 ] && printf '%s\n' "$@" > c$n/APPROVED-COMMIT.txt
  out=$(bash c$n/build-price.sh 2>&1); rc=$?
  if [ $rc = 2 ] && grep -q "$want" <<<"$out" && [ ! -e c$n/stage ]; then echo "OK   $n: $out"; else echo "FAIL $n rc=$rc: $out"; fail=1; fi; rm -rf c$n; }
case_ 1 'no APPROVED-COMMIT'
case_ 2 'exactly three lines' 'commit 9f6d37bd858ad44be1171b6415353910214c2fa5' 'gsup UNCHANGED'
case_ 3 'are not exactly 9f6d37bd' 'commit 9f6d37bd858ad44be1171b6415353910214c2fa5' 'gsup UNCHANGED' 'tests NONE'
case_ 4 'not in H' 'commit 0000000000000000000000000000000000000000' 'gsup UNCHANGED' 'tests NONE'
case_ 5 'are not exactly 9f6d37bd' 'commit a6b1378cdf430217025987d90c040d0e25a9993d' 'gsup UNCHANGED' 'tests NONE'
exit $fail
