#!/bin/bash
# root's WalletConnect leaf checks, run directly in a VM-modules process (not through the wrapper)
set -uo pipefail
cd "$(dirname "$0")/../repo"
git log -1 --format='HEAD %H'; sha256sum site/js/core/wallet.js test/walletconnect-independent-rpc.test.mjs
exec timeout -k 5 120 node --experimental-vm-modules --test test/walletconnect-independent-rpc.test.mjs
