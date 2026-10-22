#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
rm -rf stage build-a build-b; mkdir -p stage/release
(cd tree && node scripts/build-lease-relay-release.mjs ../build-a && node scripts/build-lease-relay-release.mjs ../build-b)
cmp build-a/lease-relay.mjs build-b/lease-relay.mjs && cmp build-a/manifest.json build-b/manifest.json && echo "reproducible: identical"
cp build-a/* stage/release/ && cp tree/windows/installer/install-lease-relay.ps1 stage/
