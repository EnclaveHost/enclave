#!/bin/bash
# rpc-transaction-independence offline tests, inside `unshare -r -n` (loopback only). Pins the inputs it relies on.
set -u
C=$(cd "$(dirname "$0")/.." && pwd); cd "$C" || exit 2
git rev-parse HEAD 2>/dev/null; git status --short | head -20
anvil --version | head -1; node --version; grep '"version"' node_modules/viem/package.json
sha256sum src/*.mjs test/*.mjs fixtures/artifacts/* fixtures/sources/* evidence/op-source/*
mkdir -p tmp
exec timeout -k 10 "${JOB_SEC:-420}" unshare -rn sh -c 'ip link set lo up
  if curl -s -m 3 -o /dev/null https://mainnet.base.org; then echo "UNEXPECTED: external network reachable"; exit 3; fi
  echo "external network: unreachable (as intended)"
  exec node --test --test-concurrency=1 --test-timeout=240000 "$@"' sh ${@:-test/forced-inclusion.anvil.test.mjs}
