#!/usr/bin/env bash
# Compose ONLY the A modules the hosted roles need, from A's immutable df8fbafae (git objects), onto bb86e0ce (4106c311 +
# the policy-mirror race fix). TAKE: A's base blob must equal ours (so A's version is exactly the 3-way result).
# MERGE: git merge-file ours base(9fdc1418c) theirs(df8fbafae); any conflict aborts. Writes only this tree.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure/candidate
A=refs/a/df8fbafae; B=9fdc1418c
[ "$(git rev-parse HEAD)" = bb86e0cebdd43c4ab4a5182c42fc143b30eafa6b ]; [ -z "$(git status --porcelain --untracked-files=no)" ]
TAKE="network/verified-chain.mjs network/lease-reader.mjs network/directory-server.mjs network/host-policy-runtime.mjs network/service-index.mjs
 test/verified-chain.test.mjs test/verified-chain-lifecycle.test.mjs test/lease-reader-verifier.test.mjs test/lease-reader-verifier-deadline.test.mjs test/lease-reader-terminal-snapshot.test.mjs"
MERGE="network/platform-host-policy-config.mjs network/policy-carriers.mjs network/host-services/roles.mjs network/host-services/runner.mjs network/host-services/policy-mirror.mjs"
for f in $TAKE; do
  b=$(git rev-parse -q --verify "$B:$f" || echo none); o=$(git rev-parse -q --verify "HEAD:$f" || echo none)
  [ "$b" = "$o" ] || { echo "TAKE refused: $f base $b ours $o"; exit 3; }
  git show "$A:$f" > "$f"; echo "TAKE  $f  ($(git rev-parse $A:$f | cut -c1-12))"
done
t=$(mktemp -d)
for f in $MERGE; do
  git show "$B:$f" > "$t/base"; git show "$A:$f" > "$t/theirs"
  if git merge-file -L ours -L base -L A-df8fbafae "$f" "$t/base" "$t/theirs"; then echo "MERGE $f  clean"; else echo "MERGE $f  CONFLICT"; exit 4; fi
done
rm -rf "$t"; git status --porcelain; git diff --stat | tail -3
