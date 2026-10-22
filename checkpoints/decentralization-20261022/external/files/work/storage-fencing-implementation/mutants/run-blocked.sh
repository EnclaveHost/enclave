#!/bin/bash
# run-blocked.sh <mutant>: apply a PATCH U1-B mutant, then run the blocked-listing tests in the scratch copy
cd "$(dirname "$0")" || exit 2
python3 blocked-mutants.py "$1" || exit 3
cd sia-s3 && CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="$PWD/../target" cargo test --offline --target x86_64-unknown-linux-gnu blocked -- --test-threads=1 > ../blocked/$1.out 2>&1
rc=$?
grep -E "^test .*(FAILED|ok)$|^test result|^error" ../blocked/$1.out | grep -E "FAILED|test result|^error"
echo "mutant $1 cargo exit=$rc"
