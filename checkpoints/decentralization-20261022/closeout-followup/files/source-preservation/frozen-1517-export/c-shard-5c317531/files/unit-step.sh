#!/bin/bash
# unit-step.sh [cargo test args...]: sia_storage's own unit tests on the vendored sources, native, offline, one job,
# the tree's private target dir, with feature "mock" (as sia-s3's tests build it). SIA_SDK_VENDOR selects another vendor
# tree (the negative control). unit/Cargo.toml is regenerated from the vendored manifest each run (make-manifest.py).
cd "$(dirname "$0")/unit" || exit 2
python3 make-manifest.py || exit 3
[ -f Cargo.lock ] || cp ../sia-s3/Cargo.lock Cargo.lock
export CARGO_TARGET_DIR="$(dirname "$PWD")/target" CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=1
cargo test --offline --target x86_64-unknown-linux-gnu --lib --features mock "$@" > ../logs/unit-last.out 2>&1
rc=$?
grep -E "^error|^ *--> |^test |^test result|panicked|^failures:" ../logs/unit-last.out | head -150
echo "cargo exit=$rc"
exit $rc
