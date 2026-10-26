#!/bin/bash
# Must itself run within the coordinated memory guard. No authority is granted.
set -euo pipefail
if test "$#" != 5; then
  echo 'usage: evaluate-candidate.sh BINARY EXPECTED_SHA256 CONTEXT WITNESS ENVELOPE' >&2
  exit 2
fi
binary=$1
expected=$2
actual=$(sha256sum "$binary")
test "${actual%% *}" = "$expected" || { echo 'Native binary pin differs' >&2; exit 9; }
# Hash-then-exec is only for the isolated reviewed fixture workspace. Production
# needs the existing owned-process copied-byte staging and qualified capability.
exec timeout --signal=TERM --kill-after=5s 90s prlimit --as=2147483648 --cpu=60 --fsize=16777216 --nproc=64 \
  "$binary" --offline-candidate "$3" "$4" "$5"
