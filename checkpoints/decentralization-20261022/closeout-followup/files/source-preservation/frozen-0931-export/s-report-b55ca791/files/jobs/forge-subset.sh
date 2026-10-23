#!/bin/bash
# the eight contract sources the independent browser rig deploys (test/helpers/independent-browser-rig.mjs), one solc job
set -euo pipefail
cd "$(dirname "$0")/../repo"
export PATH="$HOME/.foundry/bin:$PATH"
forge --version | head -1
timeout -k 10 1500 forge build --offline -j 1 contracts/EnclaveAddressBook.sol contracts/EnclaveAppCatalog.sol contracts/EnclaveDeployments.sol \
  contracts/EnclaveRegistry.sol contracts/PaymentRouter.sol contracts/PinnedSessionVaultFactory.sol contracts/SessionVault.sol \
  contracts/foundry/test/mocks/SessionMocks.sol
for a in EnclaveAddressBook.sol/EnclaveAddressBook EnclaveAppCatalog.sol/EnclaveAppCatalog EnclaveDeployments.sol/EnclaveDeployments EnclaveDeployments.sol/EnclaveLedgerBandwidth \
  EnclaveRegistry.sol/EnclaveRegistry PaymentRouter.sol/PaymentRouter PinnedSessionVaultFactory.sol/PinnedSessionVaultFactory SessionMocks.sol/MockUSDC3009 \
  SessionVault.sol/SessionVaultFactory SessionVault.sol/SessionVaultLib; do test -s contracts/foundry/out/$a.json; sha256sum contracts/foundry/out/$a.json; done
