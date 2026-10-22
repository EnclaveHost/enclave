#!/usr/bin/env bash
set -euo pipefail
exec /usr/sbin/wasmtime run -Scli -Stcp -Sinherit-network -Sallow-ip-name-lookup --env "ENCLAVE_PORTS=$ENCLAVE_PORTS" --env "ENCLAVE_CONFIG=$S3IPFS_CONFIG" /home/steven/Documents/Codex/2026-10-18/wo/work/enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm
