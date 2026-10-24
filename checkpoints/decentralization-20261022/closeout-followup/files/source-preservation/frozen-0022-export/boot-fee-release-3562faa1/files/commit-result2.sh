#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
bash scan.sh BUILD-RESULT.md commit-result2.sh logs/commit-2.out
git add -- BUILD-RESULT.md commit-result2.sh logs/commit-2.out logs/commit-2.guard.log logs/commit-2.rc
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "boot-fee release: BUILD-RESULT names the real patch file (record field is the template's pre-move name 'patch')"
git log -1 --format='%H %an <%ae>'
