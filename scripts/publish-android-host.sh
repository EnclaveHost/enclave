#!/bin/bash
# publish-android-host.sh <apk> <version> -- publish a built Android host app (the Enclave app, shielded/anchor/avf/build.sh
# with ANCHOR_STANDALONE=1, release key, NOT debuggable) to get.enclave.host/android/ on nan, and point latest.json at it.
# Earlier versions stay. The relay must already trust the build: its code hash in nan's PVM_CPU_CODE_HASHES, loaded by a
# relay restart, or a phone that installs it cannot prove itself. This script refuses a debuggable APK or one signed by
# another key, and prints the code hash to check against the relay's list.
#   scripts/publish-android-host.sh shielded/anchor/avf/out/anchor-pvm-cpu-release.apk 2026.10.14.1
# SSH: like publish-windows-host.sh (an agent holding the nan key).
set -euo pipefail
APK=${1:?usage: $0 <apk> <version>}; VERSION=${2:?usage: $0 <apk> <version>}
[[ "$VERSION" =~ ^20[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] || { echo "version is YYYY.MM.DD.N" >&2; exit 2; }
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"; BT="$SDK/build-tools/35.0.0"
TOP=$(git rev-parse --show-toplevel)
# the release key's certificate (the relay pins its authority: PVM_CPU_AUTHORITY_HASHES)
RELEASE_CERT_SHA256=867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d
"$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK" | grep -q 'debuggable(0x0101000f)=true' && { echo "refused: $APK is debuggable (a lab build)" >&2; exit 2; }
"$BT/apksigner" verify --print-certs "$APK" | grep -q "SHA-256 digest: $RELEASE_CERT_SHA256" || { echo "refused: $APK is not signed by the release key" >&2; exit 2; }
[ -f "$APK.idsig" ] || { echo "need $APK.idsig (the v4 signature: its Merkle root is the code hash)" >&2; exit 2; }
# the code hash: the APK's fs-verity Merkle root (pins.py), cross-checked against the build's own v4 signature
CODE_HASH=$(python3 -c '
import sys; sys.path.insert(0, sys.argv[1]); import pins
code = pins.fsverity_root(open(sys.argv[2], "rb").read()).hex()
if pins.parse_idsig(sys.argv[3])["rootHash"] != code: sys.exit("the idsig was not made over these apk bytes")
print(code)' "$TOP/shielded/anchor/avf" "$APK" "$APK.idsig")
[[ "$CODE_HASH" =~ ^[0-9a-f]{64}$ ]] || { echo "no code hash from pins.py" >&2; exit 2; }
ASHA=$(sha256sum "$APK" | cut -c1-64); FILE="Enclave-$VERSION.apk"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp "$APK" "$T/$FILE"
printf '%s  %s\n' "$ASHA" "$FILE" > "$T/SHA256SUMS-$VERSION"
cat > "$T/latest.json" <<JSON
{"version":"$VERSION","file":"$FILE","sha256":"$ASHA","bytes":$(stat -c%s "$APK"),"codeHash":"$CODE_HASH","signerSha256":"$RELEASE_CERT_SHA256","package":"host.enclave.pvmcpu","minSdk":34,"tested":["Pixel 10 Pro XL"]}
JSON
# the release first, the stable name next, latest.json last: a reader never sees a latest.json naming a file not there yet
ssh nan "mkdir -p /opt/enclave-get/android"
scp -q "$T/$FILE" "$T/SHA256SUMS-$VERSION" nan:/opt/enclave-get/android/
ssh nan "cp /opt/enclave-get/android/$FILE /opt/enclave-get/android/Enclave.apk.tmp && mv /opt/enclave-get/android/Enclave.apk.tmp /opt/enclave-get/android/Enclave.apk"
scp -q "$T/latest.json" nan:/opt/enclave-get/android/latest.json.tmp
ssh nan "find /opt/enclave-get/android -type f -exec chmod 0644 {} + && chmod 0755 /opt/enclave-get/android && mv /opt/enclave-get/android/latest.json.tmp /opt/enclave-get/android/latest.json"
echo "published the Enclave Android app $VERSION: apk $ASHA, code hash $CODE_HASH"
cat "$T/latest.json"
