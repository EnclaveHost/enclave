#!/usr/bin/env bash
# j3: (A) candidate: new cancellation + cleanup-failure daemon cases and the existing lifecycle cases; (B) the new file on the
# untouched baseline 4c059b9 (negative control, must fail); (C) candidate: existing coupled suites, once each, unchanged.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023
export TMPDIR=$W/tmp; mkdir -p "$TMPDIR"
T="node --test --test-concurrency=1 --test-force-exit"
cd $W/repo
echo "=== A CANDIDATE $(git rev-parse HEAD) network-diff $(git diff HEAD -- network | sha256sum | cut -c1-16) test $(sha256sum test/privacy-agent-startup-cancel.test.mjs | cut -c1-16)"
timeout -k 5 900 $T --test-timeout=120000 test/privacy-agent-startup-cancel.test.mjs test/privacy-agent-lifecycle.test.mjs; a=$?
echo "=== A rc=$a"
cd $W/baseline
[ "$(git rev-parse HEAD)" = 4c059b997360483c743deca343c2e42b1b534eeb ] && [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "baseline not pristine"; exit 2; }
cp $W/repo/test/privacy-agent-startup-cancel.test.mjs test/
echo "=== B BASELINE 4c059b9 (negative control)"
timeout -k 5 900 $T --test-timeout=120000 test/privacy-agent-startup-cancel.test.mjs; b=$?
rm -f test/privacy-agent-startup-cancel.test.mjs
echo "=== B rc=$b"
cd $W/repo
echo "=== C CANDIDATE coupled suites"
timeout -k 5 1500 $T --test-timeout=300000 \
  test/privacy-agent-config.test.mjs test/privacy-agent-proofs.test.mjs test/host-service-lifecycle.test.mjs \
  test/host-service-transport.test.mjs test/host-services-carriers.test.mjs test/host-services-cold-start.test.mjs \
  test/network-consumer-bundle.test.mjs test/provider-canary-independent.test.mjs; c=$?
echo "=== C rc=$c"
[ "$a" -eq 0 ] && [ "$b" -ne 0 ] && [ "$c" -eq 0 ]
