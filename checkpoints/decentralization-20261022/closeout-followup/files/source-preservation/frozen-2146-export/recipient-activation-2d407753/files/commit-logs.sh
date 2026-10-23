#!/bin/bash
# Follow-up: commit commit-1's own queue logs (its final clean-tree check failed only because they were being written).
set -euo pipefail
cd "$(dirname "$0")"
git add logs/commit-1.out logs/commit-1.guard.log logs/commit-1.rc commit-logs.sh
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "activation adaptation: commit-1 queue logs (its clean-tree check saw only its own logs)"
git log -1 --format='%H %an <%ae>'
