#!/usr/bin/env bash
# A copy of CURRENT main (no .git; real node_modules) with the candidate's files laid over it at main's paths, to run
# main's permanent tests (and the ported ones) against the candidate exactly as root would integrate it. Main is only READ.
#   bash scripts/build-main-overlay.sh   -> overlay-main/ + overlay-main.files (candidate file : sha256)
set -eu
cd "$(dirname "$0")/.."
M=../enclave O=overlay-main
rm -rf "$O"; rsync -a --exclude=.git "$M/" "$O/"
# candidate source : main path (main's network/lease-executor-client.mjs stays its re-export of ../client/)
PAIRS=(
  client/lease-executor-client.mjs:client/lease-executor-client.mjs
  network/lease-gas-owner.mjs:network/lease-gas-owner.mjs
  network/lease-release-journal.mjs:network/lease-release-journal.mjs
  network/lease-relay-service.mjs:network/lease-relay-service.mjs
  cli/lease-gas.mjs:cli/lease-gas.mjs
  shadow-win/windows/node/chain.mjs:windows/node/chain.mjs
  shadow-win/windows/node/host.mjs:windows/node/host.mjs
  shadow-b/supervisor.js:supervisor.js
  shadow-b/Dockerfile:Dockerfile
)
for f in $(cd port-main && find . -type f | sed 's#^\./##' | sort); do PAIRS+=("port-main/$f:$f"); done
: > overlay-main.files
for p in "${PAIRS[@]}"; do c=${p%%:*}; m=${p#*:}; mkdir -p "$O/$(dirname "$m")"; cp -L "$c" "$O/$m"; echo "$(sha256sum "$c" | cut -c1-64)  $m  ($c)" >> overlay-main.files; done
cat overlay-main.files
