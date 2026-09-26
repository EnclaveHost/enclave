#!/usr/bin/env bash
# Rollback of B step 1: revert B's two commits on main (a new commit, pushed = a relay + site deploy of the pre-B code). Only
# after rolling back steps 3, 2 and 1b first (each's own rollback), in that order. Then b-accept.sh 1 rollback.
set -euo pipefail; source "$(dirname "$0")/lib.sh"
git -C $MAIN fetch -q origin main
W=$(mktemp -d); trap 'git -C $MAIN worktree remove --force "$W" 2>/dev/null || rm -rf "$W"' EXIT
git -C $MAIN worktree add -q --detach "$W" origin/main
git -C "$W" merge-base --is-ancestor $BC HEAD || { say "REFUSING: main does not contain B"; exit 2; }
git -C "$W" revert --no-edit $BASE..$BC >/dev/null
[ -z "$(git -C "$W" diff $BASE HEAD -- relay/ site/js/core/pricing.js scripts/host-delegation.mjs)" ] || { say "REFUSING: the revert does not restore BASE's relay/site files (main moved in between: decide by hand)"; exit 2; }
say "B rollback: pushing the revert $(git -C "$W" rev-parse --short HEAD) to main"
git -C "$W" push origin HEAD:refs/heads/main 2>&1 | tail -2
