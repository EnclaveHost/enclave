#!/usr/bin/env bash
# j5: (A) candidate after the cleanup-message fix: the new daemon file + existing lifecycle cases; (B) network-consumer-bundle,
# which j3 could not run (gitignored relay/network-runtime.bundle.mjs absent; now copied byte-identical from S's tree);
# (C) j4-diag38.sh: cold-start "unknown chain policy" with its daemon output, candidate and baseline once each.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023
export TMPDIR=$W/tmp
cd $W/repo
echo "=== A CANDIDATE $(git rev-parse HEAD) network-diff $(git diff HEAD -- network | sha256sum | cut -c1-16) test $(sha256sum test/privacy-agent-startup-cancel.test.mjs | cut -c1-16)"
timeout -k 5 900 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 test/privacy-agent-startup-cancel.test.mjs test/privacy-agent-lifecycle.test.mjs; a=$?
echo "=== A rc=$a"
echo "=== B network-consumer-bundle"
timeout -k 5 600 node --test --test-concurrency=1 --test-force-exit --test-timeout=300000 test/network-consumer-bundle.test.mjs; b=$?
echo "=== B rc=$b"
echo "=== C diag38"
$W/j4-diag38.sh
[ "$a" -eq 0 ] && [ "$b" -eq 0 ]
