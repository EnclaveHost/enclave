#!/bin/bash
# run-tests.sh [TREE] [FILTER]: the sia-s3 crate's tests (default filter: recovery), offline, in a private network
# namespace, -j 4, hard deadline (JOB_SEC, default 590). Its own target dir; never the source worktree's.
set -u
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/sia-whole-bucket-recovery
TREE="${1:-$HERE/repo}"; FILTER="${2:-recovery}"
cd "$TREE/sia-s3" || exit 2
export CARGO_TARGET_DIR="$HERE/target" CARGO_NET_OFFLINE=true
git -C "$TREE" rev-parse HEAD 2>/dev/null; sha256sum src/recovery.rs
# several trees share one target dir: force this tree's sources to rebuild (cargo compares mtimes)
touch src/recovery.rs
exec timeout -k 10 "${JOB_SEC:-590}" unshare -rn sh -c 'ip link set lo up && exec cargo test --offline --locked --target x86_64-unknown-linux-gnu -j 4 "$0" -- --test-threads="${TEST_THREADS:-4}"' "$FILTER"
