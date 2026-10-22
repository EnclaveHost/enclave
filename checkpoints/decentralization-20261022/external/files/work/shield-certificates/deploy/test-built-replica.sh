#!/usr/bin/env bash
# Build the route replica release (dns.mjs + network-runtime.bundle.mjs + manifest) from work/shield-certificates/tree with
# the app-zone build script (copied byte-identical), then run the Shield replica process suite with the BUILT dns.mjs as
# every replica's entry. Synthetic fixtures; nothing deployed. Run via the shared queue (768 MiB).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
node build-dns.mjs dist
[ -s dist/dns.mjs ] && [ -s dist/network-runtime.bundle.mjs ] && [ -s dist/dns.mjs.manifest.json ] || { echo "FAIL build outputs missing"; exit 1; }
cmp -s dist/network-runtime.bundle.mjs ../tree/relay/network-runtime.bundle.mjs && echo "[built] runtime bundle = the tested tree bundle" || echo "[built] runtime bundle rebuilt (differs from the tree's)"
sha256sum dist/dns.mjs dist/network-runtime.bundle.mjs dist/dns.mjs.manifest.json
APPZONE_REPLICA_ENTRY="$PWD/dist/dns.mjs" bash ../tree/test/run-shield-certificates.sh replica
