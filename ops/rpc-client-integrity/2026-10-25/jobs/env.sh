# Shared settings for the base L1-verification jobs (sourced). Everything lives under $W; nothing shared is written.
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next
BASE_REPO=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/vendor-inspect/base-v1.5.1
BASE_REV=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
PATCH=$W/base-l1-verify.patch
BUILD=$W/build                                   # src/ (patched), src-control/ (verification disabled), target/, cargo-home/
export CARGO_HOME=$BUILD/cargo-home CARGO_TARGET_DIR=$BUILD/target
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2} CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
