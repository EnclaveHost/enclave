#!/usr/bin/env bash
# New isolated tree from the IMMUTABLE final runtime integration (source 0de09415, evidence dda47a35; read only).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-feature-gap-repair-20261023
O=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023/candidate
cd "$H"; [ ! -e candidate ]
git clone -q --local --no-hardlinks --no-checkout "$O" candidate
cd candidate; git remote remove origin
git checkout -q -b gap/windows-feature-repair dda47a35008e989cc6e62c1a79f0fefde49b29f5
[ "$(git rev-parse HEAD~1)" = 0de09415815a9ca6382fc58af81b88cff193522c ]
git config core.hooksPath .githooks
for d in node_modules network/node_modules relay/node_modules e2e/node_modules sdk/sessions/node_modules; do [ -d "$O/$d" ] && cp -a "$O/$d" "$d"; done
mkdir -p contracts/foundry; cp -a "$O/contracts/foundry/out" contracts/foundry/out
cp -a "$O/relay/network-runtime.bundle.mjs" relay/network-runtime.bundle.mjs
[ -d "$O/network/host-services/packages" ] && cp -a "$O/network/host-services/packages" network/host-services/packages
git status --porcelain --untracked-files=no | wc -l; echo SETUP_OK
