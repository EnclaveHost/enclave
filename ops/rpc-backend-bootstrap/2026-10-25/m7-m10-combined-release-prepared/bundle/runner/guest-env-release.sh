# GUEST settings for release-job.sh (sourced). Guest paths only.
M=${M10_STAGE:?release stage}          # /srv/m10-guest-validation/stage-release-1 (read-only)
OLD=${M10_OLD_STAGE:?old stage}        # /srv/m10-guest-validation/stage (MANIFEST dd9df0ab: toolchain + base tar)
CACHE=${M10_CACHE:?run-1 build}        # /srv/m10-guest-validation/runs/run-1/build (ENDED; its cargo-home is reused)
RUN2=${M10_RUN2:?run-2}                # /srv/m10-guest-validation/runs/run-2 (ENDED, passed; its tree is only READ)
REL=${M10_REL:?release run dir}        # /srv/m10-guest-validation/release/run-N (new)
BASE_REV=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
BASE_TAR_SHA=a92160ebd00fc807dcea3e275e493438c38cf51e9308c04ed741fac538ff75e2
M7_PATCH_SHA=e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312
M10_FIXED_SHA=d97c31b591d41fa5d18ca628ea06eb8efdbccf196122b8e05b1d06c69bf2e0a3
SRC_MANIFEST=58c572cbb0258bd40f799ec7fac28003529428352d0cd1fe2b82b5556b784405   # 2533 files: tar + M7 + fixed M10 (computed on the build host)
LOCK_SHA=f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f
EPOCH=1792689943                                # base 5476069f commit time (as the M7 release)
PROFILE=m7m10-release-nolto                      # = workspace [profile.release] (opt 3, cgu 16, strip symbols, panic unwind) with lto=false, as M7
TC=$OLD/toolchain/rust-1.96.0
export PATH=$TC/bin:/usr/bin:/bin
S=$REL/build/tree; TGT=$REL/build/target; OUT=$REL/out; L=$REL/logs   # NEW release tree/target/out; nothing shared is reused but the cargo home
export CARGO_HOME=$CACHE/cargo-home CARGO_TARGET_DIR=$TGT CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never
