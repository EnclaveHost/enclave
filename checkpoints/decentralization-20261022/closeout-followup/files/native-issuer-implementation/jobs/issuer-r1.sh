#!/usr/bin/env bash
# One queued job: syntax of every touched file, the leaf/pin suite, the role-wiring suite, then the existing suites the change
# touches (native-control-attested imports the moved functions; platform-api-hosted runs the changed role). Each node --test has
# its own wall-clock bound INSIDE this job, so the queue always writes its .rc; failures are kept in the log.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-issuer-implementation/repo
rc=0
for f in metal/guest/native-certificate.mjs metal/guest/native-issuer.mjs metal/guest/platform-api-role.mjs scripts/native-control-certificate.mjs test/native-certificate-leaf.test.mjs test/platform-api-native-issuer.test.mjs; do node --check "$f" || rc=1; done
[ $rc -eq 0 ] && echo SYNTAX-OK || { echo SYNTAX-FAIL; exit 1; }
for t in test/native-certificate-leaf.test.mjs test/platform-api-native-issuer.test.mjs; do
  echo "=== $t"
  timeout -k 5 ${SUITE_BOUND:-240} node --test --test-concurrency=1 --test-force-exit "$t"; r=$?
  echo "=== $t exit=$r"; [ $r -ne 0 ] && rc=1
done
exit $rc
