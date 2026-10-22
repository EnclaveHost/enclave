#!/usr/bin/env bash
# The EXISTING suites over the changed files: native-control-attested (the CLI's moved request/pin/install functions) and
# platform-api-hosted (the changed role: relay env, archive pairs, credentials path).
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-issuer-implementation/repo
rc=0
for t in test/native-control-attested.test.mjs test/platform-api-hosted.test.mjs; do
  echo "=== $t"; timeout -k 5 270 node --test --test-concurrency=1 --test-force-exit "$t"; r=$?; echo "=== $t exit=$r"; [ $r -ne 0 ] && rc=1
done
exit $rc
