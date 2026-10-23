#!/bin/bash
# r2: r1 first Helios eth_call exceeded the 20 s client timeout with an empty witness cache; r2 logs debug + gateway stats, 240 s per call.
# rpc-priority: READ-ONLY live fixture capture for the Base EVM backend (record-base-calls.mjs). Public RPC reads only
# (mainnet.base.org for witnesses + headers, base.gateway.tenderly.co for header/eth_call cross-check); no tx.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
BIN=$W/helios-target-base/debug/helios
sha256sum $BIN
OUT=$W/fixtures/base-calls-$(date -u +%Y%m%dT%H%M%SZ)
timeout -k 10 1500 node $W/fixture-tools/record-base-calls.mjs $W/repo $BIN $OUT
echo "FIXTURE $OUT"
