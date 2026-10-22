#!/bin/bash
# cargo-step.sh <check|test|build> [args...]: one cargo invocation in the candidate, native target, offline,
# isolated target dir. Prints compiler errors and the final test summary; exits with cargo's status.
cd "$(dirname "$0")/sia-s3" || exit 2
export CARGO_TARGET_DIR="$PWD/target"
# no debug info: keeps rustc + rust-lld under the shared queue's 1024 MiB process-tree cap (memory-guard)
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1
sub=$1; shift
cargo "$sub" --offline --target x86_64-unknown-linux-gnu "$@" > ../logs/cargo-last.out 2>&1
rc=$?
grep -E "^error|^ *--> |^warning: unused|^test result|FAILED|panicked|^failures:|^    [a-z_:]+$" ../logs/cargo-last.out | head -120
echo "cargo exit=$rc"
exit $rc
