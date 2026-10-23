#!/bin/bash
set -euo pipefail
task_root=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/sia-whole-bucket-recovery
cd "$task_root/repo/sia-s3"
test "$(git rev-parse HEAD)" = e8f0997f97826d31abd83cf2261bec45aad53f65
test "$(sha256sum src/recovery.rs | cut -d' ' -f1)" = 7d2c1d413b0955a4253bccddaf1c24e0a409dbb166e8d6281004e3ef3e2fbe8b
export CARGO_TARGET_DIR="$task_root/target" CARGO_NET_OFFLINE=true
timeout -k 10 600 cargo build --offline --locked --target x86_64-unknown-linux-gnu -j 1 --bin sia-s3
sha256sum "$task_root/target/x86_64-unknown-linux-gnu/debug/sia-s3"
