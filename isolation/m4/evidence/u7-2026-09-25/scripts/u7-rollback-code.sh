#!/usr/bin/env bash
# U7 rollback, nan + nan-relay (7.5): `git revert` of the converged commit pushed to main (the same relay-only CI scope;
# main stays == deployed). us-west FIRST if it already runs U7. The step-1 env lines are inert for old code and may stay.
set -euo pipefail; source ~/enclave-bench/u7-20260925/lib.sh
$US 'test -e /opt/nan-relay/relay.js.pre-u7' && [ "$($US 'sha256sum /opt/nan-relay/relay.js' | cut -c1-64)" = "$RELAY_SHA" ] && { say "REFUSING: us-west still runs U7: run u7-rollback-uswest.sh first"; exit 2; }
git -C $MAIN fetch -q origin main; [ "$(git -C $MAIN rev-parse origin/main)" = "$U7C" ] || { say "REFUSING: main is not the converged commit (it moved): revert by hand after review"; exit 2; }
W=$(mktemp -d); flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree add -q --detach "$W/r" origin/main
( cd "$W/r" && git revert --no-edit "$U7C" && git push origin HEAD:refs/heads/main )
flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree remove --force "$W/r"; rm -rf "$W"
say "U7 code rollback pushed: main = revert of $U7C; follow its Deploy run (relay-only)"
