# GUEST settings for m10-guest-test.sh (sourced). Guest paths only; nothing from the build host is referenced.
# Same build settings as the host M10 env.sh (c627839b): debug info 0 for dev and test, no incremental, no colour.
M=${M10_STAGE:?M10_STAGE (read-only stage root) required}
RUN=${M10_RUN:?M10_RUN (per-run directory) required}
BASE_REV=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
BASE_TAR_SHA=a92160ebd00fc807dcea3e275e493438c38cf51e9308c04ed741fac538ff75e2   # git archive 5476069f (git 2.56.0 on the build host)
M7_PATCH_SHA=e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312
TC=$M/toolchain/rust-1.96.0                     # copy of the official rustup dist 1.96.0 (ac68faa20); no rustup on the guest
export PATH=$TC/bin:/usr/bin:/bin
B=$RUN/build                                    # FRESH: tree/, control/, cargo-home/, target/ (must not exist before the run)
export CARGO_HOME=$B/cargo-home CARGO_TARGET_DIR=$B/target
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2} CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
