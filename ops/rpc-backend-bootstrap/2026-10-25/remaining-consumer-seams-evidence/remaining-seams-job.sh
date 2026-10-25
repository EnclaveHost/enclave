#!/bin/bash
# Offline (unshare -rn) focused tests for the directory + qualifier seams. Shared queue --mib 256.
set -u
ip link set lo up
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source
export TMPDIR=/tmp
sha256sum network/qualifier-chain.mjs network/directory-server.mjs scripts/network/wg-qualify.mjs test/qualifier-chain-authority.test.mjs test/directory-reader-authority.test.mjs
timeout -k 10 400 node --test --test-concurrency=1 --test-timeout=120000 test/qualifier-chain-authority.test.mjs test/directory-reader-authority.test.mjs test/public-directory.test.mjs test/lease-reader-verifier.test.mjs test/chain-authority.test.mjs 2>&1
rc=$?; echo "job rc=$rc"; exit $rc
