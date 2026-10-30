# GUEST run-2 settings for m10-guest-test-2.sh (sourced). Same build settings as host env.sh (c627839b) and guest-env.sh (fd0669c1).
M=${M10_STAGE:?M10_STAGE (read-only repair stage) required}          # /srv/m10-guest-validation/stage-import-recovery
OLD=${M10_OLD_STAGE:?M10_OLD_STAGE (read-only verified stage) required}  # /srv/m10-guest-validation/stage (MANIFEST dd9df0ab)
RUN=${M10_RUN:?M10_RUN (run-2 directory) required}                  # /srv/m10-guest-validation/runs/run-2
CACHE=${M10_CACHE:?M10_CACHE (ended run-1 build) required}           # /srv/m10-guest-validation/runs/run-1/build
BASE_REV=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
BASE_TAR_SHA=a92160ebd00fc807dcea3e275e493438c38cf51e9308c04ed741fac538ff75e2
M7_PATCH_SHA=e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312
M10_FIXED_SHA=d97c31b591d41fa5d18ca628ea06eb8efdbccf196122b8e05b1d06c69bf2e0a3   # original 0a10cf86 + ONE test-only import line
TC=$OLD/toolchain/rust-1.96.0
export PATH=$TC/bin:/usr/bin:/bin
B=$RUN/build                                    # FRESH: tree/ and control/ only (must not exist before the run)
export CARGO_HOME=$CACHE/cargo-home CARGO_TARGET_DIR=$CACHE/target   # REUSED mutable caches of the ENDED run 1 (no copy)
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2} CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
