#!/bin/bash
# rpc-gossip-bridge offline tests: real pinned listener (commitment mode + offline lifecycle), real captured Base objects,
# A's op-head-relay.mjs @97785a40c (byte-identical copy). Inside `unshare -r -n`: no route to any peer or provider.
set -euo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-gossip-bridge
cd "$B"
echo "ebd045b428227530fac1c1b079f47c67ecb874637a1c7dcb4f021dd5929e8d3a  artifacts/enclave-base-head-listener" | sha256sum -c -
git log --oneline -1
node --version
exec unshare -r -n bash -c '
  set -euo pipefail
  ip link set lo up
  if curl -s -m 3 -o /dev/null https://mainnet.base.org; then echo "UNEXPECTED: external network reachable"; exit 3; fi
  echo "external network: unreachable (as intended)"
  timeout -k 10 600 node --test --test-force-exit --test-concurrency=1 --test-timeout=300000 \
    test/gossip-head-source.test.mjs
'
