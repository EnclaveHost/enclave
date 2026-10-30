# bytecode-v2-validation job settings (sourced; derived from bytecode-native-validation/jobs/env.sh, only S changed). Everything written is under $S/build and $S/logs. The pinned base repo
# and the M7 cargo home are only READ (git archive / one copy); nothing frozen or shared is written.
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-v2-validation
BASE_REPO=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/vendor-inspect/base-v1.5.1
BASE_REV=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
BASE_LOCK_SHA=f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f
SRC_CARGO_HOME=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/build/cargo-home
B=$S/build                                    # tree/ (git archive + member), cargo-home/ (private copy), target/, tmp/
export CARGO_HOME=$B/cargo-home CARGO_TARGET_DIR=$B/target TMPDIR=$B/tmp
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never CARGO_NET_OFFLINE=true
