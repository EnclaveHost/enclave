#!/usr/bin/env bash
# Ship scripts/ipfs-add-gateway.py to the nan box and restart its unit.
#
# The gateway lives in /opt/enclave-gateway, deliberately OUTSIDE /opt/nan-site:
# site/deploy.sh replaces that whole tree on every site deploy, which is how the
# gateway script got deleted on 2026-07-07 (uploads then 502'd, surfacing in the
# browser as a CORS failure). Unit: nan-wasm-gateway.service on the nan box.
set -euo pipefail
cd "$(dirname "$0")"

ssh nan 'mkdir -p /opt/enclave-gateway'
scp ipfs-add-gateway.py nan:/opt/enclave-gateway/ipfs-add-gateway.py
ssh nan 'systemctl restart nan-wasm-gateway && systemctl is-active nan-wasm-gateway'
