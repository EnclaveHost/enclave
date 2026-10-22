#!/bin/bash
# LOCAL only: exact canary blocks from compose5's stage-tool (fdd42acd source tree), no network.
set -e
T=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/compose5
O=/home/steven/Documents/Codex/2026-10-18/wo/work/hs-transport-final-review-20261021/combined-canary/blocks
mkdir -p $O
for v in http dns; do
  node $T/network/host-services/stage-tool.mjs host-services --endpoint https://api.enclave.host/t/nucbox-k11-4 --zone app.enclave.host \
    --exit c4c7888e4741dcbe2c092dd81e888bf7=146.190.246.39 $([ $v = dns ] && echo --dns) > $O/host-services.$v.json
done
node --input-type=module -e "
import { keccak256, toBytes } from '$T/node_modules/viem/_esm/index.js';
console.log(JSON.stringify({ endpoint: 'https://api.enclave.host/t/nucbox-k11-4', keccak: keccak256(toBytes('https://api.enclave.host/t/nucbox-k11-4')) }));" > $O/host-id.json
sha256sum $O/*.json
