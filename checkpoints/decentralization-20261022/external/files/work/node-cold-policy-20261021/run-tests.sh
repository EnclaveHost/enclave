#!/usr/bin/env bash
# the new cold-start test + the existing wallet-policy and tick tests, against each patched tree
N=$(cd "$(dirname "$0")" && pwd)
for v in deployed canonical; do
  echo "== tree-$v ($(sha256sum $N/tree-$v/windows/node/host.mjs | cut -c1-8))"
  ( cd $N/tree-$v && node --test --test-concurrency=1 test/windows-node-wallet-cold-start.test.mjs test/windows-node-wallet-policy.test.mjs test/windows-node-tick-single-flight.test.mjs 2>&1 \
    | grep -E "^(not )?ok|^# (pass|fail)|error:|expected|actual|AssertionError" | head -60 )
done
