#!/usr/bin/env bash
# Rollback of the owner-grace push (as pace-rollback.sh): revert the 2 pushed commits on main (a new commit, pushed = a relay deploy of the pre-window code).
# Refuses if main moved past PC (decide by hand). Then og-accept is moot; run the health check.
set -euo pipefail; source "$(dirname "$0")/lib.sh"
git -C $MAIN fetch -q origin main
[ "$(git -C $MAIN rev-parse origin/main)" = "$PC" ] || { say "REFUSING: main is not PC ${PC:0:12}: decide by hand"; exit 2; }
W=$(mktemp -d); trap 'git -C $MAIN worktree remove --force "$W" 2>/dev/null || rm -rf "$W"' EXIT
git -C $MAIN worktree add -q --detach "$W" origin/main
git -C "$W" revert --no-edit $BASE..$PC >/dev/null
[ -z "$(git -C "$W" diff $BASE HEAD -- relay/ test/)" ] || { say "REFUSING: the revert does not restore BASE's files"; exit 2; }
say "owner-grace ROLLBACK: pushing the revert $(git -C "$W" rev-parse --short HEAD) to main"
git -C "$W" push origin HEAD:refs/heads/main 2>&1 | tail -2
# (5d's optional) watch the revert's Deploy and require nan to run BASE's two files again (hashes from BASE itself)
rv=$(git -C "$W" rev-parse HEAD)
for i in $(seq 1 60); do run=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --json databaseId,headSha --jq ".[] | select(.headSha==\"$rv\") | .databaseId" | head -1); [ -n "$run" ] && break; sleep 5; done
[ -n "${run:-}" ] || { say "ROLLBACK: pushed, but no Deploy run appeared: check by hand"; exit 3; }
gh run watch "$run" --repo EnclaveHost/enclave --exit-status > $B/rollback-deploy-watch.txt 2>&1 || true
for f in tunnel.js api-relay.js; do SHA[$f]=$(git -C $MAIN show $BASE:relay/$f | sha256sum | cut -c1-64); done
files_are_pc tunnel.js api-relay.js && say "owner-grace ROLLBACK deployed (run $run): nan runs BASE's tunnel.js + api-relay.js; now run health" \
  || { say "ROLLBACK: Deploy $run done, but nan does not run BASE's files: check by hand"; exit 4; }
