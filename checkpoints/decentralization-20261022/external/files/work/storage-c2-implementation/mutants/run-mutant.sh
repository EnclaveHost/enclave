#!/bin/bash
# run-mutant.sh <mutant>: apply one C2 mutant to the scratch copy, then run the C2 tests there (own target dir)
cd "$(dirname "$0")" || exit 2
python3 c2_mutants.py "$1" || exit 3
cd sia-s3 && CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="$PWD/../target" cargo test --offline --target x86_64-unknown-linux-gnu -j 1 --bin sia-s3 c2_ -- --test-threads=1 > ../out/$1.out 2>&1
rc=$?
grep -E "^test .* FAILED$|^test result|^error" ../out/$1.out
echo "mutant $1 cargo exit=$rc"
