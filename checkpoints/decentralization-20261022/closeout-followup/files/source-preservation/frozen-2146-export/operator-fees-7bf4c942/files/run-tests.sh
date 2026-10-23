#!/bin/bash
# run-tests.sh <label>: the suite, TAP to logs/<label>.tap
cd "$(dirname "$0")" && mkdir -p logs
node --test --test-concurrency=1 --test-reporter=tap test/proposer.test.mjs > "logs/$1.tap" 2>&1; rc=$?
grep -E "^(not )?ok |^# (tests|pass|fail)" "logs/$1.tap"; echo "node exit=$rc"; exit $rc
