#!/bin/bash
# publish-windows-host.sh <out-dir> -- publish a built Windows host release (windows/installer/build-bundle.ps1's output:
# enclave-host-<version>.zip, EnclaveSetup.exe, SHA256SUMS) to get.enclave.host/windows/ on nan, and point latest.json at
# it. Earlier versions stay. cli/host.ps1 (the one-line install) is copied to get.enclave.host/host.ps1 too.
# SSH: like site/deploy.sh (the nan-ci-deploy key in an agent).
set -euo pipefail
OUT=${1:?usage: $0 <out-dir>}
ZIP=$(ls "$OUT"/enclave-host-*.zip | sort | tail -1); SETUP="$OUT/EnclaveSetup.exe"
[ -f "$ZIP" ] && [ -f "$SETUP" ] || { echo "need enclave-host-*.zip and EnclaveSetup.exe in $OUT" >&2; exit 1; }
VERSION=$(basename "$ZIP" .zip | sed 's/^enclave-host-//')
SETUP_VERSIONED="EnclaveSetup-$VERSION.exe"
ZSHA=$(sha256sum "$ZIP" | cut -c1-64); SSHA=$(sha256sum "$SETUP" | cut -c1-64)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp "$ZIP" "$T/"; cp "$SETUP" "$T/$SETUP_VERSIONED"
printf '%s  %s\n%s  %s\n' "$ZSHA" "$(basename "$ZIP")" "$SSHA" "$SETUP_VERSIONED" > "$T/SHA256SUMS-$VERSION"
cat > "$T/latest.json" <<JSON
{"version":"$VERSION","file":"$(basename "$ZIP")","sha256":"$ZSHA","bytes":$(stat -c%s "$ZIP"),"setup":"$SETUP_VERSIONED","setupSha256":"$SSHA"}
JSON
TOP=$(git rev-parse --show-toplevel)
cp "$TOP/cli/host.ps1" "$T/host.ps1"
# the release files first, latest.json last: a reader never sees a latest.json naming files that are not there yet
ssh nan "mkdir -p /opt/enclave-get/windows"
scp -q "$T/$(basename "$ZIP")" "$T/$SETUP_VERSIONED" "$T/SHA256SUMS-$VERSION" nan:/opt/enclave-get/windows/
scp -q "$T/latest.json" nan:/opt/enclave-get/windows/latest.json.tmp
scp -q "$T/host.ps1" nan:/opt/enclave-get/host.ps1
ssh nan "mv /opt/enclave-get/windows/latest.json.tmp /opt/enclave-get/windows/latest.json && chmod 0644 /opt/enclave-get/windows/* /opt/enclave-get/host.ps1"
echo "published Enclave host $VERSION: zip $ZSHA, setup $SSHA"
cat "$T/latest.json"
