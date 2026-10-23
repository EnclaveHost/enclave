#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure/candidate
[ "$(git rev-parse HEAD)" = 30123801a279479f1dc9406d417e7bfa17b9f023 ]
git add network/host-services/roles.mjs network/host-services/runner.mjs test/helpers/loopback-verifier.mjs test/host-service-verifier-roles.test.mjs
[ -z "$(git status --porcelain --untracked-files=no | grep -v '^M  \|^A  ' || true)" ]
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F ../commit-msg-3.txt
git log -4 --format='%H %an <%ae> / %cn <%ce> %s'; git status --porcelain
git format-patch --full-index --no-signature -o ../patches 4106c3114dd13f39692195c182d3152efa5e212c..HEAD
git diff 4106c3114dd13f39692195c182d3152efa5e212c HEAD > ../host-service-rpc-closure.patch; sha256sum ../host-service-rpc-closure.patch ../patches/*.patch
