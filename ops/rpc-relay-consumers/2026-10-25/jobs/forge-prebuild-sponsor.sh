#!/bin/bash
# Prebuild ONLY the two contracts the sponsor E2E deploys (one source per invocation, one thread): EnclaveRegistry, EnclaveHostPaymaster
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source || exit 2
for src in contracts/EnclaveRegistry.sol contracts/EnclaveHostPaymaster.sol; do
  echo "== forge build -j 1 $src"; forge build -j 1 "$src" 2>&1 | tail -3
done
for a in EnclaveRegistry.sol/EnclaveRegistry EnclaveHostPaymaster.sol/EnclaveHostPaymaster; do
  f=contracts/foundry/out/$a.json; [ -s "$f" ] && echo "ok $f $(sha256sum < $f | cut -c1-16)" || { echo "MISSING $f"; exit 1; }
done
