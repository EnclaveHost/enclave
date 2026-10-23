#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle/candidate
[ "$(git rev-parse HEAD)" = 24fb993c4f9df6868ca06f210ab7b9abec10e502 ]
git add network/host-service-transport.mjs test/host-service-lifecycle.test.mjs
[ -z "$(git status --porcelain --untracked-files=no | grep -v '^M  ' || true)" ]
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F ../commit-msg-2.txt
git log -2 --format='%H %an <%ae> / %cn <%ce> %s'; git show --stat --format= HEAD
rm -f ../0001-*.patch ../0002-*.patch
git format-patch --full-index --no-signature -o .. 427780bbc0fc524f8091893614eae8a653518139..HEAD
git diff 427780bbc0fc524f8091893614eae8a653518139 HEAD > ../host-service-lifecycle.patch; sha256sum ../host-service-lifecycle.patch ../000*.patch
git -C ../mut checkout -q --detach HEAD 2>/dev/null || true
git -C ../mut checkout -q --detach "$(git rev-parse HEAD)"; git -C ../mut rev-parse HEAD
