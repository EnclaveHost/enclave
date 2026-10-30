#!/bin/bash
# Offline build of kzgcheck against c-kzg 2.1.8 exactly as pinned in base-v1.5.1/Cargo.lock.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
BASE_LOCK=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/witness-failover/vendor-inspect/base-v1.5.1/Cargo.lock
cd "$HERE/kzgcheck"
export CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="$HERE/kzgcheck/target"
[ -f Cargo.lock ] || cargo generate-lockfile --offline
python3 lockcheck.py "$BASE_LOCK" . --fix
python3 lockcheck.py "$BASE_LOCK" .
cargo build --release --offline --locked
sha256sum Cargo.lock target/release/kzgcheck
