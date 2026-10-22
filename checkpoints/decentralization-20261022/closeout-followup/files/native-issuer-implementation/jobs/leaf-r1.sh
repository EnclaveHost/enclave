#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-issuer-implementation/repo
for f in metal/guest/native-certificate.mjs metal/guest/native-issuer.mjs metal/guest/platform-api-role.mjs scripts/native-control-certificate.mjs test/native-certificate-leaf.test.mjs; do node --check "$f"; done
echo SYNTAX-OK
node --test --test-concurrency=1 test/native-certificate-leaf.test.mjs
