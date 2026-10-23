#!/usr/bin/env bash
# J3: the four repaired baseline fixtures. site-independent-management three times (it was nondeterministic before the
# confirmed-claim fix) and the other Safe-helper user; release-journal with an EMPTY capability bounding set so its
# permission negative is real; lease-readiness, whose native PowerShell gate must be reported NOT RUN (not passed).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023; cd "$H"; rc=0
for i in 1 2 3; do ./run-suite.py j3-mgmt-$i -- test/site-independent-management.test.mjs || rc=1; done
./run-suite.py j3-startup -- test/site-independent-account-startup.test.mjs || rc=1
./run-suite.py j3-journal --drop-caps 'test/windows-release-journal.test.mjs' -- test/windows-release-journal.test.mjs || rc=1
# negative control: the same file WITH the namespace's capabilities must FAIL test 4 (the guard sees the writable directory)
if ./run-suite.py j3-journal-negctl -- test/windows-release-journal.test.mjs; then echo "[j3] NEGCTL UNEXPECTEDLY PASSED"; rc=1; else echo "[j3] negctl failed as required"; fi
./run-suite.py j3-readiness -- test/windows-node-lease-readiness.test.mjs || rc=1
echo "[j3] rc=$rc"; exit $rc
