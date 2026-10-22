#!/usr/bin/env bash
# Domain-review deliverable manifest (cwd work/app-lease-gas): the main files the delta is against, every candidate and
# main-layout file it carries, the generators, tests and the run logs cited by work/claude-gas-domain-review-result.txt.
set -eu
cd "$(dirname "$0")/.."
{
  echo "# main (current, read only): the bases of patches/current-main-delta.patch"
  (cd ../enclave && sha256sum client/lease-executor-client.mjs network/lease-gas-owner.mjs network/lease-release-journal.mjs network/lease-relay-service.mjs \
    cli/lease-gas.mjs windows/node/chain.mjs windows/node/host.mjs supervisor.js Dockerfile network/lease-relay-check.mjs relay/systemd/enclave-lease-relay.service \
    docs/network/lease-relay-release.md test/lease-authority.test.mjs test/lease-gas-owner-cli.test.mjs test/lease-relay-release.test.mjs \
    test/windows-release-journal.test.mjs windows/node/lease-gas-runtime.bundle.mjs contracts/EnclaveLeaseExecutor.sol contracts/EnclaveLeaseGasReserve.sol | sed 's#  #  ../enclave/#')
  echo "# candidate sources and generated candidates"
  sha256sum client/lease-executor-client.mjs network/lease-gas-owner.mjs network/lease-release-journal.mjs network/lease-relay-service.mjs cli/lease-gas.mjs \
    contracts/EnclaveLeaseExecutor.sol contracts/EnclaveLeaseGasReserve.sol shadow-win/windows/node/chain.mjs shadow-win/windows/node/host.mjs \
    shadow-win/windows/node/lease-gas-runtime.bundle.mjs shadow-b/supervisor.js shadow-b/Dockerfile shadow-b/network/lease-executor-client.mjs
  echo "# main-layout files (port-main/<main path>) and the tested overlay"
  (find port-main -type f | sort | xargs sha256sum)
  sha256sum overlay-main.files overlay-main/windows/node/lease-gas-runtime.bundle.mjs
  echo "# delta"
  sha256sum patches/current-main-delta.patch patches/current-main-inventory.txt patches/current-chain.hunk.patch patches/current-supervisor.hunk.patch patches/current-dockerfile.hunk.patch
  echo "# generators and runners"
  sha256sum scripts/rebase-linux-supervisor.py scripts/delta-windows-current.py scripts/delta-against-main.sh scripts/build-main-overlay.sh scripts/run-overlay-batch.sh \
    scripts/build-windows-lease-runtime.mjs scripts/make-deployment-record.mjs scripts/queue-retry.sh
  echo "# candidate-layout tests"
  sha256sum test/lease-resolve-domain.test.mjs test/lease-relay-resilience.test.mjs test/lease-authority.test.mjs test/windows-release-journal.test.mjs \
    test/supervisor-current-runtime.test.mjs test/linux-image-closure.test.mjs
  echo "# logs"
  sha256sum logs/r3/domain-before.out logs/r3/domain-after.out logs/r3/resil1.out logs/r3/resil2.out logs/r3/domain1.out logs/r3/domain2.out \
    logs/r3/relay-control.out logs/r3/relay-control2.out
} > MANIFEST-domain.sha256
wc -l MANIFEST-domain.sha256
