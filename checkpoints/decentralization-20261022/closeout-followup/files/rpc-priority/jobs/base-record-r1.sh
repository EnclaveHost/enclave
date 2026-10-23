#!/bin/bash
# rpc-priority: READ-ONLY live fixture capture for the Base EVM backend (record-base-calls.mjs). Public RPC reads only
# (mainnet.base.org for witnesses + headers, base.gateway.tenderly.co for header/eth_call cross-check); no tx.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
BIN=$W/helios-target-base/debug/helios
sha256sum $BIN
OUT=$W/fixtures/base-calls-$(date -u +%Y%m%dT%H%M%SZ)
timeout -k 10 600 node $W/fixture-tools/record-base-calls.mjs $W/repo $BIN $OUT
echo "FIXTURE $OUT"
