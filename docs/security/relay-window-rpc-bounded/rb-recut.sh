#!/usr/bin/env bash
# (as pace-recut.sh) If main moved before the window: re-cut the reviewed commit onto the current main (cherry-pick), require the SAME
# patch-ids and file list, and that main changed nothing under relay/, site/ or scripts/ since REVIEW_BASE; force-push the
# window branch; update PC in lib.sh. Anything else refuses: a re-review.   usage: rb-recut.sh <worktree>
set -euo pipefail; source "$(dirname "$0")/lib.sh"
WT=${1:?usage: rb-recut.sh <worktree>}
git -C "$WT" fetch -q origin
m=$(context_moved "$WT"); [ -z "$m" ] || { say "REFUSING: main changed relay/site/scripts since $REVIEW_BASE: $(echo $m): re-review"; exit 4; }
[ "$(git -C "$WT" rev-parse HEAD)" = "$PC" ] || { say "REFUSING: the worktree is not at PC"; exit 2; }
git -C "$WT" rebase -q origin/main
new=$(git -C "$WT" rev-parse HEAD)
got=$(for c in $(git -C "$WT" rev-list --reverse origin/main..HEAD); do git -C "$WT" show $c | git patch-id --stable | cut -d' ' -f1; done | tr '\n' ' ' | sed 's/ $//')
[ "$got" = "$PATCHIDS" ] || { say "REFUSING: the re-cut changed a patch: re-review"; git -C "$WT" reset -q --hard "$PC"; exit 3; }
git -C "$WT" push -q --force-with-lease origin HEAD:relay/rpc-bounded
sed -i "s/^PC=[0-9a-f]\{40\}/PC=$new/" "$H/lib.sh"
say "re-cut onto $(git -C "$WT" rev-parse --short origin/main): PC ${new:0:12} (the same reviewed patch)"
