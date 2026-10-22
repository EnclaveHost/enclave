#!/bin/bash
# run-c2-acceptance.sh: the C2 acceptance tests (expected to FAIL on the frozen SDK) in the isolated copy
cd "$(dirname "$0")/sia-s3-copy" || exit 2
export CARGO_TARGET_DIR="$(dirname "$PWD")/target" CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1
cargo test --offline --target x86_64-unknown-linux-gnu c2_acceptance -- --ignored --test-threads=1 --nocapture > ../logs/c2-acceptance.out 2>&1
rc=$?
grep -E "^error|^test |^test result|panicked|C2:" ../logs/c2-acceptance.out | head -40
echo "cargo exit=$rc"
exit $rc
