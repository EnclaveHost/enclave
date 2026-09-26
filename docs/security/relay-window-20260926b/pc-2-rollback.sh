#!/usr/bin/env bash
# Rollback of step 2: revert the 4 pushed commits on main (a new commit, pushed = a relay deploy of the pre-window code).
# Refuses if main moved past PC (decide by hand). Then pc-2-accept is moot; run the health check.
set -euo pipefail; source "$(dirname "$0")/lib.sh"
git -C $MAIN fetch -q origin main
[ "$(git -C $MAIN rev-parse origin/main)" = "$PC" ] || { say "REFUSING: main is not PC ${PC:0:12}: decide by hand"; exit 2; }
W=$(mktemp -d); trap 'git -C $MAIN worktree remove --force "$W" 2>/dev/null || rm -rf "$W"' EXIT
git -C $MAIN worktree add -q --detach "$W" origin/main
git -C "$W" revert --no-edit $BASE..$PC >/dev/null
[ -z "$(git -C "$W" diff $BASE HEAD -- relay/ test/)" ] || { say "REFUSING: the revert does not restore BASE's files"; exit 2; }
say "step 2 ROLLBACK: pushing the revert $(git -C "$W" rev-parse --short HEAD) to main"
git -C "$W" push origin HEAD:refs/heads/main 2>&1 | tail -2
