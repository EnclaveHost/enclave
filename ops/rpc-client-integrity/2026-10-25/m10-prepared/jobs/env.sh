# M10 job settings (sourced). Everything is under $M; root's running M7 build and its cargo home are only READ (copied once).
M=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap
BASE_REPO=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/vendor-inspect/base-v1.5.1
BASE_REV=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
M7_PATCH_SHA=e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312
M7_CARGO_HOME=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/build/cargo-home
B=$M/build                                   # tree/ (5476069f+M7+M10), control/ (checks disabled), target/, cargo-home/
export CARGO_HOME=$B/cargo-home CARGO_TARGET_DIR=$B/target
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2} CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
