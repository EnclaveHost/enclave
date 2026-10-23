#!/bin/bash
# rpc-priority: final offline suite for helios enclave-base-evm (r4 binary, Denim horizon) inside `unshare -r -n`:
# helios-witness E2E in Base-execution mode (+ Denim-era refusal, stock 0.12.0 comparison), real-Base replay
# (fixture base-calls-20261023T014412Z; shipped default now executes Cobalt-era state), relay + gateway unit suites.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority
BASEBIN=$W/helios-target-base/debug/helios
COMPAT=$W/helios-target/debug/helios
STOCK=$W/vendor-inspect/helios-release-0.12.0/bin/helios
FIX=$W/fixtures/base-calls-20261023T014412Z
echo "0929f7f383a082b8aa7fda97c3058e72a4acc93cbf250a24c7a08ae4e1df98fc  $COMPAT" | sha256sum -c -
echo "a7f777b430c04f030b1f337c157a13a368aea11c14315b7be79095026f619180  $STOCK" | sha256sum -c -
sha256sum $BASEBIN
(cd $W/helios-patched && git log --oneline -1 && git status --short)
(cd $W/repo && git log --oneline -1)
mkdir -p $W/test-scratch
cd $W/repo
exec unshare -r -n bash -c '
  set -euo pipefail
  ip link set lo up
  if curl -s -m 3 -o /dev/null https://mainnet.base.org; then echo "UNEXPECTED: external network reachable"; exit 3; fi
  echo "external network: unreachable (as intended)"
  EXPECT_BASE_EXECUTION=1 BASE_DEFAULT_REFUSES=0 HELIOS_BIN='"$BASEBIN"' HELIOS_BASE_BIN='"$BASEBIN"' HELIOS_COMPAT_BIN='"$COMPAT"' \
  HELIOS_STOCK_BIN='"$STOCK"' BASE_FIXTURE_DIR='"$FIX"' ANVIL_BIN=$(command -v anvil) TEST_TMP='"$W"'/test-scratch \
    timeout -k 10 1200 node --test --test-force-exit --test-concurrency=1 \
      test/helios-base-replay.e2e.test.mjs test/helios-witness.e2e.test.mjs test/op-head-relay.test.mjs test/witness-gateway.test.mjs
'
