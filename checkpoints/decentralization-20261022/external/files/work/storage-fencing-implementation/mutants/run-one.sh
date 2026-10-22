#!/bin/bash
# run-one.sh <mutant>: apply it, then run the fencing tests in the scratch copy (its own target dir)
cd "$(dirname "$0")" || exit 2
python3 mutants.py "$1" || exit 3
cd sia-s3 && CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="$PWD/../target" cargo test --offline --target x86_64-unknown-linux-gnu fencing -- --test-threads=1 > ../$1.out 2>&1
rc=$?
grep -E "^test .*(FAILED|ok)$|^test result|^error" ../$1.out | grep -E "FAILED|test result|^error"
echo "mutant $1 cargo exit=$rc"
