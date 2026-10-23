#!/bin/bash
# Scan then commit ONLY the listed source files (never git add -A: root may write runtime files here).
set -euo pipefail
cd "$(dirname "$0")"
FILES=".gitignore README.md review-progress.txt build-price.sh precheck.py verify.py entries.py q.sh scan.sh commit.sh refusal-tests/run.sh tests/test_precheck.py tests/test_verify.py $(ls logs/tests-*.out logs/tests-*.guard.log logs/tests-*.rc)"
bash scan.sh $FILES
git add -- $FILES
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "boot-price release: approval-gated bounded build template for the child of 9f6d37bd (not run)

precheck.py: single parent 9f6d37bd, delta exactly supervisor.js + approved tests (+ gsup only if root REVIEWED), builder
unchanged, parent-anchored source patch free of the rewritten literal. build-price.sh: 9f control == root-built 08d1f838,
candidate twice identical, verify.py exact manifest/entry delta + image = commit bytes, ed918e4b/ee5df6b8/08d1f838 reproduced.
Tests 10/10 + refusals 5/5. review-progress.txt: early criteria for H's pending-GPU/read-failure guard."
git log -1 --format='%H %an <%ae>'
