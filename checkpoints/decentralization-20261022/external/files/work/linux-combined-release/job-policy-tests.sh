#!/bin/sh
# Focused verification of the regenerated policy bundles on actual main (768: node --test children). Main asserted unchanged.
set -u
M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-combined-release; P=$L/policy-bundles
cd $M; rc=0
treehash() { find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; }
treehash > $P/tests-before.sha256
node scripts/build-host-admission.mjs --check && echo "BUILDER-CHECK-CLEAN" || rc=1
echo "== host-admission-runtime (source)"; node --test --test-reporter=tap test/host-admission-runtime.test.mjs > $P/t-runtime-source.tap 2>&1 || rc=1; grep -E "^# (pass|fail|skipped|todo)" $P/t-runtime-source.tap
echo "== host-admission-runtime (GENERATED windows/node/host-admission.bundle.mjs)"; ADMISSION_BUNDLE_TEST=1 node --test --test-reporter=tap test/host-admission-runtime.test.mjs > $P/t-runtime-bundle.tap 2>&1 || rc=1; grep -E "^# (pass|fail|skipped|todo)" $P/t-runtime-bundle.tap
echo "== metal/policy/mirror/callsite/site/deploy suites"; node --test --test-reporter=tap test/metal-host-policy.test.mjs test/metal-launcher-isolation.test.mjs test/windows-node-deploy-files.test.mjs test/host-policy-mirrors.test.mjs test/host-policy-callsites.test.mjs test/site-host-policy.test.mjs > $P/t-suites.tap 2>&1 || rc=1; grep -E "^# (tests|pass|fail|skipped|todo)" $P/t-suites.tap; grep -E "^not ok" $P/t-suites.tap | head
echo "== generated entrypoints"; node $P/entrypoints.mjs || rc=1
treehash > $P/tests-after.sha256
cmp -s $P/tests-before.sha256 $P/tests-after.sha256 && echo "MAIN-UNCHANGED-BY-TESTS" || { echo "MAIN CHANGED BY TESTS:"; diff $P/tests-before.sha256 $P/tests-after.sha256 | head; rc=1; }
[ $rc = 0 ] && echo POLICY-TESTS-OK || echo POLICY-TESTS-FAILED; exit $rc
