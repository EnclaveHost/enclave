#!/bin/bash
# Final integration lineage from exact Git objects only (format-patch / am; no worktree content is read):
#   base  A rpc-priority/repo df8fbafa (0c43 + 437d/2efc/71448 + deadline b56a/f344 + fd6 25c0 + e820 + Windows df8f)
#   + P witness-cache-deadline-compose/repo 9fdc1418c..9e838ba7 (10 commits: proof gateway, ancestry, history, blocks,
#     deadlines, E S3 archive/history, composition)
#   + B rpc-runtime-composition/repo 1ad7c4a3e..8c8fa957 (bridge import, runtime, closure, deadline-test race, A-test adaptation)
#   + root root-rpc-kernel-lock 794d2ff3 (parent-owned kernel flock module + tests; source-only.patch)
set -euo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022
F=$B/rpc-runtime-final-integration
A=df8fbafae081321f3c9a9c774e41007200913f32 P=9e838ba758b96f96eb9858e35f4898a95fc5cba7 PBASE=9fdc1418c
C=8c8fa957ceeef4f3cbc116552656067157007db5 CBASE=1ad7c4a3e0c6f8f1f279bb82d9633a58ffc903ff L=794d2ff3c7e9e99a9fa92b54390030cb46f108cf
export GIT_CONFIG_NOSYSTEM=1
[ -e $F/repo ] && { echo "repo exists"; exit 2; }
mkdir -p $F/lineage/p $F/lineage/b $F/lineage/lock
git -C $B/witness-cache-deadline-compose/repo format-patch -q --no-signature --binary -o $F/lineage/p $PBASE..$P
git -C $B/rpc-runtime-composition/repo format-patch -q --no-signature --binary -o $F/lineage/b $CBASE..$C
# root README: integrate ONLY source-only.patch (export commit 336ea56a): runtime-lock.mjs + its two tests
[ "$(git -C $B/root-rpc-kernel-lock show 336ea56ab458fa4f80481f332fd44f3bf88ded1f:source-only.patch | sha256sum)" = "$(sha256sum < $B/root-rpc-kernel-lock/source-only.patch)" ]
git -C $B/root-rpc-kernel-lock show 336ea56ab458fa4f80481f332fd44f3bf88ded1f:source-only.patch > $F/lineage/lock/0001-runtime-lock-source-only.patch
git clone -q --local --no-hardlinks --no-checkout $B/rpc-priority/repo $F/repo
cd $F/repo
git remote remove origin
git config user.name SteveDeFacto; git config user.email 5148995+SteveDeFacto@users.noreply.github.com
git config core.hooksPath .githooks
git checkout -q -b runtime-final $A
git am -q --committer-date-is-author-date $F/lineage/p/*.patch
git am -q --committer-date-is-author-date $F/lineage/b/*.patch
git am -q --committer-date-is-author-date $F/lineage/lock/*.patch
git log --oneline $A~1..HEAD
check() { local repo=$1 c=$2 base=$3 bad=0
  while read -r f; do want=$(git -C $repo rev-parse "$c:$f" 2>/dev/null || echo deleted); have=$(git rev-parse "HEAD:$f" 2>/dev/null || echo deleted)
    [ "$want" = "$have" ] || { echo "MISMATCH $f want $want have $have"; bad=1; }; done < <(git -C $repo diff --name-only $base $c)
  return $bad; }
check $B/rpc-priority/repo $A $PBASE && echo "A (9fdc..df8f) files identical to df8fbafa"
check $B/witness-cache-deadline-compose/repo $P $PBASE && echo "P (9fdc..9e838) files identical to 9e838ba7"
check $B/rpc-runtime-composition/repo $C $CBASE && echo "B (1ad7..8c8f) files identical to 8c8fa957"
for f in network/runtime-lock.mjs test/runtime-lock.test.mjs test/lock-child.mjs; do [ "$(git -C $B/root-rpc-kernel-lock rev-parse $L:$f)" = "$(git rev-parse HEAD:$f)" ] || { echo "MISMATCH $f"; exit 4; }; done; echo "lock files identical to 794d2ff3 (3 files)"
echo "tree $(git rev-parse HEAD^{tree}) head $(git rev-parse HEAD)"
sha256sum $F/lineage/*/*.patch
echo LINEAGE_OK
