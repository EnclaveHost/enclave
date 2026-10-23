#!/bin/bash
# r2: r1 hook failed on a test-side JSON.stringify(BigInt) assertion message; the fix touches only the test.
# rpc-priority: JS unit tests (relay, gateway) + offline E2E with the patched Helios binary and stock 0.12.0 comparison,
# all inside `unshare -r -n` (no external network: every external RPC provider is unreachable).
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
STOCK=$W/vendor-inspect/helios-release-0.12.0/bin/helios
echo "a7f777b430c04f030b1f337c157a13a368aea11c14315b7be79095026f619180  $STOCK" | sha256sum -c -
PATCHED=$W/helios-target/debug/helios
sha256sum "$PATCHED"
mkdir -p $W/test-scratch
cd $W/repo
git log --oneline -1
exec unshare -r -n bash -c '
  set -euo pipefail
  ip link set lo up
  if curl -s -m 3 -o /dev/null https://mainnet.base.org; then echo "UNEXPECTED: external network reachable"; exit 3; fi
  echo "external network: unreachable (as intended)"
  HELIOS_BIN='"$PATCHED"' HELIOS_STOCK_BIN='"$STOCK"' ANVIL_BIN=$(command -v anvil) TEST_TMP='"$W"'/test-scratch \
    timeout -k 10 900 node --test --test-force-exit --test-concurrency=1 \
      test/helios-witness.e2e.test.mjs test/op-head-relay.test.mjs test/witness-gateway.test.mjs
'
