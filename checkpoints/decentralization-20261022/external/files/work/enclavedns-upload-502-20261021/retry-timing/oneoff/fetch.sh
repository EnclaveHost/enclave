#!/usr/bin/env bash
# read-only SFTP copies of three installed public code files (no config, keys or logs)
cd "$(dirname "$0")/live" && for f in chain.mjs host-admission.bundle.mjs lease-gas-runtime.bundle.mjs; do timeout 60 scp -q -o BatchMode=yes -o ConnectTimeout=10 "minipc:/C:/Program Files/Enclave/control/windows/node/$f" "./$f" || exit 1; done; sha256sum *
