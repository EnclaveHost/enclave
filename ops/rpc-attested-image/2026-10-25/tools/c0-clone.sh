#!/usr/bin/env bash
# c0 (queue 1024): two INDEPENDENT clean committed sources at $C (env.sh): A = --local --no-hardlinks from the shared repository
# (copies packs); B = a full --no-local clone of A (pack-objects re-packs). Detached at the commit, clean, same tree.
set -euo pipefail
. "$(dirname "$0")/env.sh"
[ ! -e "$SA" ] && [ ! -e "$SB" ] || { echo "sources exist"; exit 2; }
git clone -q --local --no-hardlinks --no-checkout "$REPO" "$SA"
git -C "$SA" -c advice.detachedHead=false checkout -q --detach "$C"
git clone -q --no-local --no-hardlinks --no-checkout "file://$SA" "$SB"
git -C "$SB" -c advice.detachedHead=false checkout -q --detach "$C"
FULL=$(git -C "$SA" rev-parse HEAD); TA=$(git -C "$SA" rev-parse HEAD^{tree}); TB=$(git -C "$SB" rev-parse HEAD^{tree})
echo "[src] A $FULL tree $TA"; echo "[src] B $(git -C "$SB" rev-parse HEAD) tree $TB"
need "A and B at the same commit" [ "$FULL" = "$(git -C "$SB" rev-parse HEAD)" ]
need "A and B same tree" [ "$TA" = "$TB" ]
need "commit is $C" [ "${FULL:0:9}" = "${C:0:9}" ]
need "A clean" [ -z "$(git -C "$SA" status --porcelain --untracked-files=all)" ]
need "B clean" [ -z "$(git -C "$SB" status --porcelain --untracked-files=all)" ]
need "B shares no object store with A" [ ! -e "$SB/.git/objects/info/alternates" ]
stub_none
echo CLONE-OK
