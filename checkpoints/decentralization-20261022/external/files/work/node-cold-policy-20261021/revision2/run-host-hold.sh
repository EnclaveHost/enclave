#!/usr/bin/env bash
# revision-2 host integration: the new integrated suite (bounded: node --test per-test timeouts; whole run <= 240 s)
cd "$(dirname "$0")/tree" && timeout 240 node --test --test-concurrency=1 test/windows-node-wallet-network-hold.test.mjs 2>&1
