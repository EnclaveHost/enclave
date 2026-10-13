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
# DELTA UPDATES (update-host.ps1): every file of the release by its sha256 under files/, and the release's manifest. Only
# the hashes nan does not have yet are sent, so a release that changed one file uploads one file.
mkdir -p "$T/store/files"
ssh nan "mkdir -p /opt/enclave-get/windows/files && ls /opt/enclave-get/windows/files" > "$T/have.txt"
python3 - "$ZIP" "$T/store" "$T/have.txt" "$VERSION" <<'PY'
import hashlib, json, os, sys, zipfile
zpath, store, have_file, version = sys.argv[1:5]
have = set(open(have_file).read().split())
z = zipfile.ZipFile(zpath)
entries = {i.filename.replace("\\", "/"): i for i in z.infolist() if not i.is_dir()}
raw = z.read(entries["manifest.json"])
man = json.loads(raw.decode("utf-8-sig"))
if man.get("version") != version: sys.exit(f"the zip's manifest is for {man.get('version')}, not {version}")
sent = 0
for f in man["files"]:
    data = z.read(entries[f["path"]])
    if hashlib.sha256(data).hexdigest() != f["sha256"]: sys.exit(f"{f['path']} does not match its manifest")
    if f["sha256"] in have: continue
    have.add(f["sha256"]); sent += 1
    open(os.path.join(store, "files", f["sha256"]), "wb").write(data)
open(os.path.join(store, f"manifest-{version}.json"), "wb").write(raw)
print(f"file store: {len(man['files'])} files, {sent} new")
PY
MSHA=$(sha256sum "$T/store/manifest-$VERSION.json" | cut -c1-64)
cat > "$T/latest.json" <<JSON
{"version":"$VERSION","file":"$(basename "$ZIP")","sha256":"$ZSHA","bytes":$(stat -c%s "$ZIP"),"setup":"$SETUP_VERSIONED","setupSha256":"$SSHA","manifest":"manifest-$VERSION.json","manifestSha256":"$MSHA"}
JSON
TOP=$(git rev-parse --show-toplevel)
cp "$TOP/cli/host.ps1" "$T/host.ps1"
# the release files first, latest.json last: a reader never sees a latest.json naming files that are not there yet
ssh nan "mkdir -p /opt/enclave-get/windows"
scp -q "$T/$(basename "$ZIP")" "$T/$SETUP_VERSIONED" "$T/SHA256SUMS-$VERSION" nan:/opt/enclave-get/windows/
tar -C "$T/store" -czf - . | ssh nan "tar -xzf - -C /opt/enclave-get/windows"
# the stable name the Host page's download button links to (a copy of this version's setup)
ssh nan "cp /opt/enclave-get/windows/$SETUP_VERSIONED /opt/enclave-get/windows/EnclaveSetup.exe.tmp && mv /opt/enclave-get/windows/EnclaveSetup.exe.tmp /opt/enclave-get/windows/EnclaveSetup.exe"
scp -q "$T/latest.json" nan:/opt/enclave-get/windows/latest.json.tmp
scp -q "$T/host.ps1" nan:/opt/enclave-get/host.ps1
ssh nan "find /opt/enclave-get/windows -type d -exec chmod 0755 {} + && find /opt/enclave-get/windows -type f -exec chmod 0644 {} + && chmod 0644 /opt/enclave-get/host.ps1 && mv /opt/enclave-get/windows/latest.json.tmp /opt/enclave-get/windows/latest.json && chmod 0644 /opt/enclave-get/windows/latest.json"
echo "published Enclave host $VERSION: zip $ZSHA, setup $SSHA"
cat "$T/latest.json"
