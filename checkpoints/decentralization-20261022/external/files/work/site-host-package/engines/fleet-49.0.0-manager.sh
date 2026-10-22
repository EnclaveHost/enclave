#!/usr/bin/env bash
# Shared-CVM tier: the fleet engine itself (/bin/wasmtime of ghcr.io/enclavehost/enclave-wasmtime@sha256:13bce266…,
# the image wasm/Dockerfile.wasm pins), with the wasm manager's own serve flags (test/e2e.mjs passes them unchanged).
H="$(cd "$(dirname "$0")/../fleet-engine" && pwd)"
LD_LIBRARY_PATH="$H/lib" exec "$H/wasmtime" "$@"
