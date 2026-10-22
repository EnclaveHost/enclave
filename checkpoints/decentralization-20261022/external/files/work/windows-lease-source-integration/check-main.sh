#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
node scripts/build-windows-lease-runtime.mjs --check
node ../windows-lease-source-integration/check-main-imports.mjs
node windows/node/deploy-files.mjs > ../windows-lease-source-integration/main-closure.txt
node --check windows/node/host.mjs
node --check windows/node/chain.mjs
node --check cli/enclave.mjs
