#!/bin/bash
# guard-check.sh: compile and run the fencing/policy tests of the copy-mode guard patch (integration/scratch = candidate
# AFTER + copy-mode-guard.patch), native, offline, isolated target (integration/target), one job.
cd "$(dirname "$0")/scratch" || exit 2
export CARGO_TARGET_DIR="$(dirname "$PWD")/target" CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1
cargo test --offline --target x86_64-unknown-linux-gnu -- fencing:: c2_the_production_shaped_boot fencing_fails_closed config::tests --test-threads=2 > ../guard-check.out 2>&1
rc=$?
grep -E "^error|^ *--> |^test |test result" ../guard-check.out | head -60
echo "cargo exit=$rc"
exit $rc
