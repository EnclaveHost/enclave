#!/bin/bash
# rpc-priority: OFFLINE replay of recorded real Base calls through the patched Helios Base EVM backend, inside
# `unshare -r -n` (no network). Plus the JS unit suites touched since r2 (gateway methods option).
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
FIX=${1:?fixture dir}
BASEBIN=$W/helios-target-base/debug/helios
COMPAT=$W/helios-target/debug/helios
echo "0929f7f383a082b8aa7fda97c3058e72a4acc93cbf250a24c7a08ae4e1df98fc  $COMPAT" | sha256sum -c -
sha256sum $BASEBIN
mkdir -p $W/test-scratch
cd $W/repo
exec unshare -r -n bash -c '
  set -euo pipefail
  ip link set lo up
  if curl -s -m 3 -o /dev/null https://mainnet.base.org; then echo "UNEXPECTED: external network reachable"; exit 3; fi
  echo "external network: unreachable (as intended)"
  HELIOS_BASE_BIN='"$BASEBIN"' HELIOS_COMPAT_BIN='"$COMPAT"' BASE_FIXTURE_DIR='"$FIX"' TEST_TMP='"$W"'/test-scratch \
    timeout -k 10 900 node --test --test-force-exit --test-concurrency=1 test/helios-base-replay.e2e.test.mjs test/witness-gateway.test.mjs
'
