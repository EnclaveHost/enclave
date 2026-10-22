#!/bin/sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021/revision2/network-tree
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="REAL platform host policy gate" test/challenge-replica-host.test.mjs 2>&1 | grep -v "^\s*at " | head -30
