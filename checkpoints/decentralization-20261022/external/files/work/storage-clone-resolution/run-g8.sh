#!/bin/bash
# run-g8.sh: the TEST-ONLY G8 counterexamples in the isolated copy (native, offline, own target dir, 1 job, no debuginfo)
cd "$(dirname "$0")/sia-s3-copy" || exit 2
export CARGO_TARGET_DIR="$(dirname "$PWD")/target" CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1
cargo test --offline --target x86_64-unknown-linux-gnu g8_counterexample -- --test-threads=1 --nocapture > ../logs/g8.out 2>&1
rc=$?
grep -E "^error|G8-EVIDENCE|^test |^test result|panicked" ../logs/g8.out | head -40
echo "cargo exit=$rc"
exit $rc
