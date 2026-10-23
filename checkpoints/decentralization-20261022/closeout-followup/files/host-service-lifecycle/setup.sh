#!/usr/bin/env bash
# Own candidate from C's exact commit 427780bbc. Reads C's repo/node_modules only; never writes there.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle
C=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-host-services-compose/candidate
cd "$HERE"
[ ! -e candidate ]
git clone -q --local --no-hardlinks --no-checkout "$C" candidate
cd candidate
git remote remove origin
git checkout -q -b fix/host-service-lifecycle 427780bbc0fc524f8091893614eae8a653518139
[ "$(git rev-parse HEAD)" = 427780bbc0fc524f8091893614eae8a653518139 ]
[ -z "$(git status --porcelain)" ]
for d in node_modules network/node_modules relay/node_modules e2e/node_modules sdk/sessions/node_modules; do
  [ -d "$C/$d" ] && [ ! -L "$C/$d" ] && cp -a "$C/$d" "$d"
done
git status --porcelain | head
sha256sum network/host-service-transport.mjs network/privacy-agent.mjs
echo SETUP_OK
