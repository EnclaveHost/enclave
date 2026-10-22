#!/usr/bin/env bash
# Builds the lease-relay host-role package from CURRENT main (work/enclave) into package/, then rebuilds and --checks it
# (reproducibility). Run through the shared queue (256 MiB). Writes nothing outside this workspace.
set -euo pipefail
cd "$(dirname "$0")"
M=../enclave
node $M/scripts/build-lease-relay-host-package.mjs "$PWD/package" | tee logs/package-build.json
node $M/scripts/build-lease-relay-host-package.mjs "$PWD/package" --check | tee logs/package-check.json
node $M/scripts/build-lease-relay-migration-check.mjs "$PWD/package/gate" --expect-sha256 80d64e2f4cb37e1982e0a04423be8c16f2a681175d8fd93ac697fbf6016084f0 | tee logs/gate-build.json
sha256sum package/lease-relay.mjs package/lease-relay.package.json package/gate/lease-relay-migration-check.mjs
