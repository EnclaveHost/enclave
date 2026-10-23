#!/bin/bash
# r2: r1 2/3; readiness now waits for the top head (server drains its queue once per second) - test-only.
# rpc-priority: offline head-path E2E with REAL Base unsafe heads (B's captured objects) through the patched
# opstack-server (--objects-dir, --no-gossip), our relay and the patched Helios client (real Base signer). unshare -r -n.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
sha256sum $W/helios-target-base/debug/helios $W/helios-target-base/debug/opstack-server
mkdir -p $W/test-scratch
cd $W/repo
exec unshare -r -n bash -c '
  set -euo pipefail
  ip link set lo up
  if curl -s -m 3 -o /dev/null https://mainnet.base.org; then echo "UNEXPECTED: external network reachable"; exit 3; fi
  echo "external network: unreachable (as intended)"
  HELIOS_BASE_BIN='"$W"'/helios-target-base/debug/helios OPSTACK_SERVER_BIN='"$W"'/helios-target-base/debug/opstack-server \
  BASE_HEADS_DIR='"$W"'/fixtures/base-heads-b-live-20261023T013719Z TEST_TMP='"$W"'/test-scratch \
    timeout -k 10 600 node --test --test-force-exit --test-concurrency=1 test/helios-base-head.e2e.test.mjs
'
