#!/bin/bash
# Scan then commit ONLY the public build metadata (never the image binaries in stage/dist-*).
set -euo pipefail
cd "$(dirname "$0")"
FILES="BUILD-RESULT.md README.md APPROVED-COMMIT.txt stage/build-record.json stage/INVENTORY.sha256 stage/5db2be3f4-on-9f6d37bd.patch stage/entries-vs-9f.jsonl stage/entries-vs-production.jsonl logs/root-build-fee.out logs/root-build-fee.rc logs/root-build-fee.guard.log logs/root-build-fee2.out logs/root-build-fee2.rc logs/root-build-fee2.guard.log logs/commit-1.out logs/commit-1.guard.log logs/commit-1.rc commit-result.sh"
bash scan.sh $FILES
git add -f -- $FILES
[ -z "$(git diff --cached --name-only | grep '^stage/dist-')" ] || { echo "image binary staged"; exit 1; }
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "boot-fee release: record root's approved 5db2be3f build (bc731956) - public metadata only

Approval, build-record.json (0d8c682a), inventory, parent-anchored source patch, entry deltas, root's PASS log (23:28-23:32:21Z)
and the preserved first refusal (no approval file). README corrected: root built it; D took no action. Images not committed."
git log -1 --format='%H %an <%ae>'
