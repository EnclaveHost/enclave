#!/usr/bin/env bash
# Before the window, if main moved: re-cut B's two commits onto the current main in e3's B worktree, check that EVERY B file
# is still byte-identical to the reviewed content (BFILE), force-push the review branch, and update BC in lib.sh. A main
# commit touching a B file makes the rebase differ: refused (a real re-review then). Usage: b-recut.sh <B worktree>
set -euo pipefail; source "$(dirname "$0")/lib.sh"
WT=${1:?usage: b-recut.sh <B worktree>}
git -C "$WT" fetch -q origin
[ "$(git -C "$WT" rev-parse HEAD)" = "$BC" ] || { say "REFUSING: the worktree is not at lib.sh's BC"; exit 2; }
git -C "$WT" rebase -q origin/main
new=$(git -C "$WT" rev-parse HEAD)
[ "$(git -C "$WT" diff --name-only HEAD~2 HEAD | sort)" = "$(printf '%s\n' "${!BFILE[@]}" | sort)" ] || { say "REFUSING: the re-cut changed B's file list"; git -C "$WT" reset -q --hard "$BC"; exit 3; }
for f in "${!BFILE[@]}"; do [ "$(git -C "$WT" show HEAD:$f | sha256sum | cut -c1-64)" = "${BFILE[$f]}" ] || { say "REFUSING: the re-cut changed $f: re-review"; git -C "$WT" reset -q --hard "$BC"; exit 3; }; done
git -C "$WT" push -q --force-with-lease origin HEAD:relay/hvnode-owner-only-v2
sed -i "s/^BC=[0-9a-f]\{40\}/BC=$new/" "$H/lib.sh"
say "B re-cut onto $(git -C "$WT" rev-parse --short HEAD~2): BC ${new:0:12} (every B file byte-identical to the reviewed content)"
