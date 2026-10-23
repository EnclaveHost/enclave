#!/usr/bin/env bash
# Commit 2 = A's composition ONLY, built in a temporary index from git objects (working tree untouched); commit 3 = the rest.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure
cd "$H/candidate"; A=refs/a/df8fbafae; B=9fdc1418c
[ "$(git rev-parse HEAD)" = bb86e0cebdd43c4ab4a5182c42fc143b30eafa6b ]
T=$(mktemp -d); export GIT_INDEX_FILE="$T/index"; git read-tree HEAD
TAKE="network/verified-chain.mjs network/lease-reader.mjs network/directory-server.mjs network/host-policy-runtime.mjs network/service-index.mjs test/verified-chain.test.mjs test/verified-chain-lifecycle.test.mjs test/lease-reader-verifier.test.mjs test/lease-reader-verifier-deadline.test.mjs test/lease-reader-terminal-snapshot.test.mjs"
for f in $TAKE; do mode=$(git ls-tree $A -- "$f" | cut -d' ' -f1); git update-index --add --cacheinfo "$mode,$(git rev-parse $A:$f),$f"; done
for f in network/platform-host-policy-config.mjs network/policy-carriers.mjs network/host-services/roles.mjs network/host-services/runner.mjs network/host-services/policy-mirror.mjs; do
  git show HEAD:$f > "$T/ours"; git show $B:$f > "$T/base"; git show $A:$f > "$T/theirs"
  set +e; git merge-file -p -L ours -L base -L A-df8fbafae "$T/ours" "$T/base" "$T/theirs" > "$T/merged"; rc=$?; set -e
  if [ "$f" = network/host-services/runner.mjs ]; then [ $rc -eq 2 ]; python3 -I "$H/resolve-runner.py" < "$T/merged" > "$T/res"; mv "$T/res" "$T/merged"; echo "resolved $f (2 conflict hunks)"; else [ $rc -eq 0 ]; fi
  git update-index --add --cacheinfo "$(git ls-tree HEAD -- "$f" | cut -d' ' -f1),$(git hash-object -w "$T/merged"),$f"
done
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F "$H/commit-msg-2.txt"
unset GIT_INDEX_FILE; rm -rf "$T"; git reset -q
git log -1 --format='%H %an <%ae> / %cn <%ce>'; git show --stat --format= HEAD | tail -2
echo "--- remaining working-tree diff (must be only hardening + new tests):"; git status --porcelain; git diff --stat
