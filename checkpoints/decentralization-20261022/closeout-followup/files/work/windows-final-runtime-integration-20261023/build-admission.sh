#!/usr/bin/env bash
# Admission + metal bundles of the working tree (after verified-chain -> A 554a251c), then --check; no fleet address.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
export TMPDIR="$H/tmp/t" PATH="$H/stubs:/usr/local/bin:/usr/bin:/bin"
cd "$H/candidate"
[ "$(git rev-parse HEAD:network/verified-chain.mjs)" = "$(git rev-parse c3a61fd1a:network/verified-chain.mjs)" ]   # ours == A's base
git show refs/in/a:network/verified-chain.mjs > network/verified-chain.mjs
[ "$(git hash-object network/verified-chain.mjs)" = "$(git rev-parse refs/in/a:network/verified-chain.mjs)" ]
timeout -k 10 300 unshare -rn sh -c 'node scripts/build-host-admission.mjs && node scripts/build-host-admission.mjs --check'
sha256sum network/verified-chain.mjs windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs
for ip in 134.199.235.187 134.209.248.172 165.245.191.129 146.190.246.39; do grep -q "$ip" windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs && { echo "fleet address $ip"; exit 6; }; done; echo "no former fleet address"
