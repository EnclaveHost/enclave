#!/bin/bash
# Scan (unchanged scanners, scan.sh) then commit ONLY the template (never git add -A: root writes runtime files here later).
set -euo pipefail
cd "$(dirname "$0")"
FILES=".gitignore README.md build-price.sh precheck.py verify.py entries.py q.sh scan.sh commit-fee.sh refusal-tests/run.sh tests/test_precheck.py tests/test_verify.py logs/tests-1.out logs/tests-1.guard.log logs/tests-1.rc"
bash scan.sh $FILES
git add -- $FILES
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "boot-fee release: build template for H's next sibling child of 9f6d37bd (explicit sender fees), not run

Byte-identical to the reviewed a340762 template (precheck e6f3cb97 unchanged; control 9f6d37bd = 08d1f838); new README only;
the 7dd-specific commit.sh and every runtime file excluded. Tests 10/10, refusals 5/5."
git log -1 --format='%H %an <%ae>'
