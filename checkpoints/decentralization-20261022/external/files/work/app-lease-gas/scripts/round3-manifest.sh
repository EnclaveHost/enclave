#!/usr/bin/env bash
# Round-3 deliverable manifest (cwd work/app-lease-gas): sha256 of every CURRENT source, candidate, patch, test, plan and
# fixture the round-3 result cites, plus the main files the patches are against. Writes MANIFEST-round3.sha256.
set -eu
cd "$(dirname "$0")/.."
{
  echo "# main (current; Windows, CLI and shared sources already integrated by root)"
  (cd ../enclave && sha256sum supervisor.js Dockerfile windows/node/chain.mjs windows/node/host.mjs cli/enclave.mjs network/rpc-identity.mjs network/registry-reconcile.mjs | sed 's#  #  ../enclave/#')
  echo "# contracts (forge sources are the ones built and tested)"
  sha256sum contracts/EnclaveLeaseExecutor.sol contracts/EnclaveLeaseGasReserve.sol forge/src/EnclaveLeaseExecutor.sol forge/src/EnclaveLeaseGasReserve.sol
  echo "# shared modules"
  sha256sum client/lease-executor-client.mjs client/lease-executor-authority.mjs network/lease-executor-authority.mjs network/lease-gas-owner.mjs \
    network/lease-gas-runtime.mjs network/lease-release-journal.mjs network/lease-relay-service.mjs network/rpc-identity.mjs cli/lease-gas.mjs
  echo "# candidates (generated from current main)"
  sha256sum shadow-b/supervisor.js shadow-b/Dockerfile shadow-win/windows/node/chain.mjs shadow-win/windows/node/host.mjs \
    shadow-win/windows/node/lease-gas-runtime.bundle.mjs shadow-cli/cli/enclave.mjs
  echo "# scoped patches against current main"
  sha256sum patches/current-supervisor.hunk.patch patches/current-dockerfile.hunk.patch patches/current-chain.hunk.patch patches/current-host.hunk.patch \
    patches/lease-gas-cli-dispatch.hunk.patch
  echo "# generators"
  sha256sum scripts/rebase-linux-supervisor.py scripts/linux-supervisor-journal.hooks scripts/linux-supervisor-scheduler.hooks scripts/rebase-windows-host.py scripts/build-windows-lease-runtime.mjs \
    scripts/fork-ten-app-plan.mjs scripts/run-r3-batch.sh scripts/snapshot-safe-code.mjs scripts/enrollment-plan.mjs scripts/recovery-budget.mjs \
    scripts/make-deployment-record.mjs scripts/rebase-cli-dispatch.py scripts/refresh-shadow-links.py scripts/delta-windows-current.py scripts/delta-against-main.sh \
    control-win/windows/node/host.mjs control-win/windows/node/chain.mjs control-linux/supervisor.js patches/current-main-delta.patch patches/current-main-inventory.txt
  echo "# tests and fixtures"
  sha256sum test/*.test.mjs test/helpers/*.mjs forge/test/LeaseExecutor.t.sol forge/test/mocks/SpoofOperator.sol
  sha256sum fixtures/*.json 2>/dev/null || true
  echo "# plans"
  sha256sum plans/* 2>/dev/null || true
} > MANIFEST-round3.sha256
echo "wrote MANIFEST-round3.sha256 ($(grep -vc '^#' MANIFEST-round3.sha256) files)"
