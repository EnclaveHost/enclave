#!/bin/sh
# Focused verification of the regenerated policy bundles on actual main (768; v2: --test-concurrency=1 - v1 ran the six files in parallel and was guard-stopped at 970 MiB). Main asserted unchanged.
set -u
M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-combined-release; P=$L/policy-bundles
cd $M; rc=0
treehash() { find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; }
treehash > $P/v2-tests-before.sha256
node scripts/build-host-admission.mjs --check && echo "BUILDER-CHECK-CLEAN" || rc=1
echo "== host-admission-runtime (source)"; node --test --test-concurrency=1 --test-reporter=tap test/host-admission-runtime.test.mjs > $P/v2-t-runtime-source.tap 2>&1 || rc=1; grep -E "^# (pass|fail|skipped|todo)" $P/v2-t-runtime-source.tap
echo "== host-admission-runtime (GENERATED windows/node/host-admission.bundle.mjs)"; ADMISSION_BUNDLE_TEST=1 node --test --test-concurrency=1 --test-reporter=tap test/host-admission-runtime.test.mjs > $P/v2-t-runtime-bundle.tap 2>&1 || rc=1; grep -E "^# (pass|fail|skipped|todo)" $P/v2-t-runtime-bundle.tap
echo "== metal/policy/mirror/callsite/site/deploy suites"; node --test --test-concurrency=1 --test-reporter=tap test/metal-host-policy.test.mjs test/metal-launcher-isolation.test.mjs test/windows-node-deploy-files.test.mjs test/host-policy-mirrors.test.mjs test/host-policy-callsites.test.mjs test/site-host-policy.test.mjs > $P/v2-t-suites.tap 2>&1 || rc=1; grep -E "^# (tests|pass|fail|skipped|todo)" $P/v2-t-suites.tap; grep -E "^not ok" $P/v2-t-suites.tap | head
echo "== generated entrypoints"; node $P/entrypoints.mjs || rc=1
treehash > $P/v2-tests-after.sha256
cmp -s $P/v2-tests-before.sha256 $P/v2-tests-after.sha256 && echo "MAIN-UNCHANGED-BY-TESTS" || { echo "MAIN CHANGED BY TESTS:"; diff $P/v2-tests-before.sha256 $P/v2-tests-after.sha256 | head; rc=1; }
[ $rc = 0 ] && echo POLICY-TESTS-OK || echo POLICY-TESTS-FAILED; exit $rc
