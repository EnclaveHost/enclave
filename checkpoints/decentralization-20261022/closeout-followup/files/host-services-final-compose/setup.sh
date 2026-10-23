#!/usr/bin/env bash
# New isolated final-compose tree. Reads C's repo/node_modules/forge outputs and F's (my) lifecycle repo; writes only here.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose
C=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-host-services-compose
F=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle/candidate
cd "$HERE"; [ ! -e candidate ]
git clone -q --local --no-hardlinks --no-checkout "$C/candidate" candidate
cd candidate; git remote remove origin
git checkout -q -b final/host-services-compose 0757085e5b78ed38efc11920fb3cf4a25d7dfc4d
git fetch -q "$F" fix/host-service-lifecycle
[ "$(git rev-parse FETCH_HEAD)" = 6c38c0489d769db12e5037e7c20f7372e56d5620 ]
git log --format='%H %s' 427780bbc0fc524f8091893614eae8a653518139..FETCH_HEAD
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com merge -q --no-ff --no-edit -F ../merge-msg.txt 6c38c0489d769db12e5037e7c20f7372e56d5620
git log -1 --format='MERGE %H tree %T parents %P %an <%ae> / %cn <%ce>'
[ -z "$(git status --porcelain)" ]
git config core.hooksPath .githooks
for d in node_modules network/node_modules relay/node_modules e2e/node_modules sdk/sessions/node_modules; do
  [ -d "$C/candidate/$d" ] && [ ! -L "$C/candidate/$d" ] && cp -a "$C/candidate/$d" "$d"; done
mkdir -p contracts/foundry; cp -a "$C/candidate/contracts/foundry/out" contracts/foundry/out
(cd contracts/foundry/out && sha256sum -c --quiet "$C/carriers/forge-subset-artifacts.sha256") && echo "forge subset: 12/12 match C's recorded hashes"
git status --porcelain | head
sha256sum network/privacy-agent.mjs network/host-service-transport.mjs network/wg-circuit-runtime.mjs windows/node/host.mjs windows/node/chain.mjs
echo SETUP_OK
