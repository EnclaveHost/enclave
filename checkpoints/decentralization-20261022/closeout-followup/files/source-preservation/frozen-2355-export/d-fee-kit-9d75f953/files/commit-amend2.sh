#!/bin/bash
# Second amend of the UNPUSHED commit: drop H's files that were swept in (they stay on disk), re-record the explicit tested list, prune.
set -euo pipefail
cd "$(dirname "$0")"
sha256sum -c --quiet TESTED-SOURCE.sha256
for f in H-ACTUAL-FAILURE.txt H-actual-failure-progress.txt H-actual-failure.err H-lease-keeper-progress.txt H-lease-keeper.err; do git rm -q --cached --ignore-unmatch "$f"; done
FILES="$(awk '{print $2}' TESTED-SOURCE.sha256) TESTED-SOURCE.sha256 README.md HANDOFF.md STATUS.txt commit.sh commit-amend.sh commit-amend2.sh $(ls logs/*.out logs/*.guard.log logs/*.rc 2>/dev/null | grep -v '^logs/root-')"
bash scan.sh $FILES
git add -- $FILES
extra=$(comm -23 <(git ls-files | sort) <(printf '%s\n' $FILES | sort))
[ -z "$extra" ] || { echo "refusing: tracked files outside the explicit list: $extra"; exit 1; }
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q --amend --no-edit
git reflog expire --expire=now --all; git gc -q --prune=now
for f in H-ACTUAL-FAILURE.txt H-lease-keeper-progress.txt; do [ -e "$f" ] && ! git cat-file -e "$(git hash-object "$f")" 2>/dev/null && echo "pruned $f"; done
git log -1 --format='%H %an <%ae>'; git ls-files | wc -l
