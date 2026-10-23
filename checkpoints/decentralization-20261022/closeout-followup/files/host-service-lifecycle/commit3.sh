#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle/candidate
[ "$(git rev-parse HEAD)" = 862f65493faad2f99e568a752951dc999f10fa27 ]
git add test/host-service-lifecycle.test.mjs
[ "$(git diff --cached --name-only)" = test/host-service-lifecycle.test.mjs ]
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "Host services lifecycle test: hold the event loop while the settle-bound case waits" -m "close()'s settle timer is unref'd by design (a stop never keeps a process alive on its own). The stand-in startup in this test holds no I/O, so node ended the test early as \"Promise resolution is still pending but the event loop has already resolved\". The test now keeps one interval for the wait, as the real in-flight request and its child processes do. Test-only change."
git log -1 --format='%H %an <%ae> / %cn <%ce> %s'
rm -f ../000*.patch; git format-patch --full-index --no-signature -o .. 427780bbc0fc524f8091893614eae8a653518139..HEAD
git diff 427780bbc0fc524f8091893614eae8a653518139 HEAD > ../host-service-lifecycle.patch; sha256sum ../host-service-lifecycle.patch ../000*.patch
git -C ../mut checkout -q --detach "$(git rev-parse HEAD)"; cp test/host-service-lifecycle.test.mjs ../base/test/
JOB_SEC=240 ../job.sh test/host-service-lifecycle.test.mjs test/host-service-transport.test.mjs test/privacy-agent-lifecycle.test.mjs
