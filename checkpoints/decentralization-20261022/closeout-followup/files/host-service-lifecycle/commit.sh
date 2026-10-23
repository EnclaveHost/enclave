#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle/candidate
[ "$(git rev-parse HEAD)" = 427780bbc0fc524f8091893614eae8a653518139 ]
git config core.hooksPath .githooks
git add network/host-service-transport.mjs network/privacy-agent.mjs network/wg-circuit-runtime.mjs test/host-service-lifecycle.test.mjs
[ -z "$(git status --porcelain --untracked-files=no | grep -v '^M  \|^A  ' || true)" ]
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F ../commit-msg.txt
git log -1 --format='%H %an <%ae> / %cn <%ce>'; git show --stat --format= HEAD
git format-patch -1 --full-index --no-signature -o .. HEAD
git diff 427780bbc0fc524f8091893614eae8a653518139 HEAD > ../host-service-lifecycle.patch; sha256sum ../host-service-lifecycle.patch ../0001-*.patch
