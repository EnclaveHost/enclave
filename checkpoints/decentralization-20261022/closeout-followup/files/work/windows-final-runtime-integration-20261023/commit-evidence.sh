#!/usr/bin/env bash
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
cd "$H/candidate"; [ "$(git rev-parse HEAD)" = 0de09415815a9ca6382fc58af81b88cff193522c ]
D=checkpoints/windows-final-runtime-integration-20261023; mkdir -p "$D"
cp "$H/RESULT.md" "$H/artifacts-js-final.sha256" "$H/node-deploy-files.sha256" "$H/node-closure.tar.sha256" "$D/"
sed -i "s|$H/||" "$D/node-closure.tar.sha256"
git add "$D"; [ "$(git diff --cached --name-only | wc -l)" = 4 ]
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F - <<'MSG'
RESULT: Windows final runtime integration (TLS 1957ff23, memory accounting 9f19b7c6, A 554a251c shared module, main docs)

Evidence only; the source head is 0de09415 (tree 5cbdb670). RESULT.md, the 22 reproducible JS artifact hashes, the
89-file node deploy closure (with origin-request.mjs) and its reproducible package hash.
MSG
[ "$(git rev-parse HEAD~1^{tree})" = 5cbdb670f5b5e60cff2f91121c2bd3e127377c96 ]
git log -1 --format='%H %an <%ae> / %cn <%ce> %s'
