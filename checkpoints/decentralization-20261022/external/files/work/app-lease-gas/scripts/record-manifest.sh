#!/usr/bin/env bash
# Relay-record + credit-vault round manifest (cwd work/app-lease-gas): current main's bases of every changed file, the
# candidate files, the NEW delta, the Windows bundle, the reproducible lease relay release (artifact + its input manifest,
# whose inputs are current main + this delta) and the logs. Writes MANIFEST-record.sha256.
set -eu
cd "$(dirname "$0")/.."
{
  echo "# current main (read only): bases of patches/record-main-delta.patch"
  awk '$3 != "same" {print $2"  ../enclave/"$3}' patches/record-main-inventory.status
  echo "# candidate files (main paths) and the tested overlay listing"
  awk '$3 != "same" {print $1"  "$4}' patches/record-main-inventory.status
  sha256sum overlay-main.files
  echo "# delta against current main"
  sha256sum patches/record-main-delta.patch patches/record-main-inventory.txt
  echo "# Windows bundle (main's builder over overlay-main) and the lease relay release, built twice"
  sha256sum overlay-main/windows/node/lease-gas-runtime.bundle.mjs overlay-main/windows/node/lease-gas-runtime.bundle.mjs.manifest.json
  sha256sum relay-release-1/lease-relay.mjs relay-release-1/lease-relay-check.mjs relay-release-1/manifest.json relay-release-2/lease-relay.mjs relay-release-2/manifest.json
  echo "# tests (candidate layout) and runners"
  sha256sum test/lease-relay-resilience.test.mjs test/lease-gas-owner-cli.test.mjs scripts/run-record-batch.sh scripts/build-main-overlay.sh scripts/delta-against-main.sh scripts/record-manifest.sh
  echo "# logs"
  sha256sum logs/r3/record-before.out logs/r3/record-after.out
} > MANIFEST-record.sha256
wc -l MANIFEST-record.sha256
