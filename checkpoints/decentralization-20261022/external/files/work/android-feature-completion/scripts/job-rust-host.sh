#!/bin/bash
# pvm-rt's host tests that cover this work's change (custody_env) and its neighbours (sealed_release, app options, ffi).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion
cd $H/tree/shielded/anchor/avf/runtime/pvm-rt
export CARGO_TARGET_DIR=$H/out/pvm-rt-host-target CARGO_BUILD_JOBS=1
cargo test --locked --offline --test custody_env --test sealed_release --test httpd_app_options --test ffi 2>&1 | tail -60
