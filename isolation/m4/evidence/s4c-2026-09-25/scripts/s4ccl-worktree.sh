#!/usr/bin/env bash
# 4c-c launcher worktree, INERT (no service reads it until s4ccb-apply.sh's drop-in points WorkingDirectory at it): a
# detached worktree of the repo at 5d's reviewed launcher fix, like the iso-* trees: ~/enclave-prod/metal-<fix8>. Refuses
# unless the commit is on top of 0181bce3 (the running launcher's) and its launcher blob is the reviewed sha256; never
# touches an existing directory.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh
R=/home/steven/Projects/enclave
[[ "$LAUNCH_C" =~ ^[0-9a-f]{40}$ ]] && [[ "$LAUNCH_SHA" =~ ^[0-9a-f]{64}$ ]] || { say "REFUSING: launcher-commit.txt / launcher-sha256.txt are not set"; exit 2; }
t=$(git -C $R cat-file -t "$LAUNCH_C") && [ "$t" = commit ] || { say "REFUSING: ${LAUNCH_C:0:8} is not a commit in $R"; exit 2; }
git -C $R merge-base --is-ancestor "$OLDWC" "$LAUNCH_C" || { say "REFUSING: ${LAUNCH_C:0:8} is not on top of 0181bce3"; exit 2; }
s=$(git -C $R show "$LAUNCH_C:metal/enclave-metal.mjs" | sha256sum) && [ "${s%% *}" = "$LAUNCH_SHA" ] || { say "REFUSING: ${LAUNCH_C:0:8}'s launcher is not the reviewed blob"; exit 2; }
[ ! -e "$LW" ] || { say "REFUSING: $LW exists"; exit 3; }
git -C $R worktree add --detach "$LW" "$LAUNCH_C" >/dev/null 2>&1 || { say "the worktree add failed"; exit 4; }
check_launcher || exit 5
git -C "$LW" diff --stat "$OLDWC" "$LAUNCH_C" > $S4C/launcher-diff-stat.txt
say "launcher worktree READY (inert): $LW at ${LAUNCH_C:0:8}, launcher ${LAUNCH_SHA:0:12}; diff from 0181bce3 in launcher-diff-stat.txt"
