#!/bin/sh
# The JS suites of the touched files (after job-unit run 2's Go pass). Suites that read git history get main's .git,
# read-only and scoped (memory: candidate-tree-test-environment).
set -e
T=/home/steven/Documents/Codex/2026-10-18/wo/work/history-owner-tools/tree
cd $T
GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git GIT_WORK_TREE=$T GIT_OPTIONAL_LOCKS=0 \
node --test --test-concurrency=1 test/history-owner-tools.test.mjs test/bootstrap-package.test.mjs test/bootstrap-names.test.mjs \
  test/site-independent-names.test.mjs test/site-independent-management-unit.test.mjs test/site-independent-storage.test.mjs \
  test/bootstrap-supervisor.test.mjs test/direct-only-supervisor.test.mjs test/startup-expectation.test.mjs \
  test/windows-shield-startup.test.mjs test/windows-shield-package-transport.test.mjs
echo JS-PACKAGE-OK
node --test --test-concurrency=1 test/storage-front-binding.test.mjs test/storage-front-resource-bounds.test.mjs \
  test/storage-front-binding-release.test.mjs test/storage-front-binding-shield.test.mjs
echo JS-RELAY-OK
node --test --test-concurrency=1 test/cli.test.mjs
echo CLI-OK
