#!/usr/bin/env bash
# (immutable; v1) READ-ONLY: every relevant generator's --check against CURRENT main (work/enclave), plus the exact hashes of
# the generated outputs. Writes nothing in main.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
cd "$M"
for f in windows/node/lease-gas-runtime.bundle.mjs windows/node/lease-gas-runtime.bundle.mjs.manifest.json metal/guest/lease-gas-conduit.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs.manifest.json metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json metal/guest/mcp-server.bundle.mjs metal/guest/mcp-server.bundle.mjs.manifest.json windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs; do
  echo "BEFORE $(sha256sum "$f")"; done
for s in build-windows-lease-runtime build-metal-lease-gas build-platform-api-guest-bundle build-mcp-guest-bundle build-host-admission; do
  echo "=== $s --check"; node "scripts/$s.mjs" --check 2>&1 | tail -6; echo "EXIT $s ${PIPESTATUS[0]}"
done
