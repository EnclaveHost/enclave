#!/usr/bin/env bash
# $1 = tree dir. Runs the existing route-record + public-directory suites and the new regression test.
cd "$1" && timeout 240 node --test --test-concurrency=1 test/route-record.test.mjs test/public-directory.test.mjs test/route-partial-qualification.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^not ok|^ok|error:|AssertionError|before the fix|withheld" | head -60
