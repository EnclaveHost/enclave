#!/usr/bin/env bash
# Code rollback: push `git revert <slice>` to main (the same relay-only CI scope; main stays == deployed). Only from a
# clean worktree of origin/main whose HEAD is the slice.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
git -C $MAIN fetch -q origin main; [ "$(git -C $MAIN rev-parse origin/main)" = "$SLICE" ] || { say "REFUSING: main is not the slice (it moved): revert by hand after review"; exit 2; }
W=$(mktemp -d); flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree add -q --detach "$W/r" origin/main
( cd "$W/r" && git revert --no-edit "$SLICE" && git push origin HEAD:refs/heads/main )
flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree remove --force "$W/r"; rm -rf "$W"
say "code rollback pushed: main = revert of $SLICE; follow its Deploy run"
