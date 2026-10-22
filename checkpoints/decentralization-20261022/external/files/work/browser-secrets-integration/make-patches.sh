#!/bin/bash
# Patches for the root (work/enclave), each against the exact baseline file saved in base/ (hashes in base-manifest.sha256).
cd "$(dirname "$0")"
mk(){ out=$1; shift; : > patches/$out; for f in "$@"; do diff -u --label a/$f --label b/$f base/$f tree/$f >> patches/$out; done; echo "patches/$out: $(grep -c '^[-+][^-+]' patches/$out) changed lines"; }
mk custody-owner-read-cors.patch custody/v2/http.mjs custody/v2/ingress.mjs docs/security/custody-owner-read.md
mk dashboard-secrets-deployments.patch site/components/deployments/deployments.js
mk build-vendor-custody-v2.patch scripts/build-vendor.mjs
