#!/usr/bin/env bash
# job5.sh: (1) composed tree: the new shipped-bundle channel test + the remaining admission/network/Linux-consumer regression;
# (2) composed tree: test/host-admission-runtime against the SHIPPED bundle (ADMISSION_BUNDLE_TEST=1);
# (3) CONTROL on the unmodified normal tree f58e03e (tmp/norm, bundle 7aeb5de9): the same two must FAIL.
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-compose
NEW=test/windows-node-wallet-channel-bundle.test.mjs
echo "=== (1) composed: new test + regression"; MODE=test JOB_SEC=420 "$HERE/job.sh" $NEW $(cat "$HERE/tmp/reg-b2.txt"); r1=$?
echo "=== (2) composed: host-admission-runtime on the shipped bundle"; ADMISSION_BUNDLE_TEST=1 MODE=test JOB_SEC=60 "$HERE/job.sh" test/host-admission-runtime.test.mjs; r2=$?
echo "=== (3a) CONTROL normal tree: new test (must fail)"; TREE="$HERE/tmp/norm" MODE=test JOB_SEC=60 "$HERE/job.sh" $NEW; c1=$?
echo "=== (3b) CONTROL normal tree: host-admission-runtime (composed test file) on bundle 7aeb5de9 (decision cases must fail)"; TREE="$HERE/tmp/norm" ADMISSION_BUNDLE_TEST=1 MODE=test JOB_SEC=60 "$HERE/job.sh" test/host-admission-runtime.test.mjs; c2=$?
echo "=== (3c) CONTROL normal tree: windows-release-journal with anvil (case 4 expected to fail as on the composed tree: mapped root ignores chmod 0500)"; TREE="$HERE/tmp/norm" EXTRA_PATH=/home/steven/.foundry/bin TEST_TIMEOUT_MS=200000 MODE=test JOB_SEC=300 "$HERE/job.sh" test/windows-release-journal.test.mjs; c3=$?
echo "[job5] composed=$r1/$r2 control=$c1/$c2 release-journal-normal=$c3 (controls must be non-zero)"
[ $r1 -eq 0 ] && [ $r2 -eq 0 ] && [ $c1 -ne 0 ] && [ $c2 -ne 0 ]
