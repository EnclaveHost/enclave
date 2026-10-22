#!/bin/sh
set -eu
cd '/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release/tree'
# r10 passed builds and 24 tests. Supply read-only historical Git metadata
# for the one baseline-comparison test in this source-only snapshot.
GIT_DIR='/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git' GIT_WORK_TREE='/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release/tree' node --test --test-name-pattern='gsup: the legacy path' test/metal-measured-control.test.mjs
sh '/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release/job-stage.sh'
sh '/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release/job-release.sh'
