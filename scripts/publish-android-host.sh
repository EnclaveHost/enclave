#!/bin/bash
# publish-android-host.sh <apk> <version> --target SSH_HOST [--target SSH_HOST ...] [--directory ABS_PATH]
# Publish a built Android host app (shielded/anchor/avf/build.sh with ANCHOR_STANDALONE=1,
# release key, NOT debuggable) to each operator-selected server and point latest.json at it.
# Earlier versions stay. Each admitting relay must already trust the build: its code hash in PVM_CPU_CODE_HASHES, loaded by a
# relay restart, or a phone that installs it cannot prove itself. This script refuses a debuggable APK or one signed by
# another key, and prints the code hash to check against the relay's list.
#   scripts/publish-android-host.sh shielded/anchor/avf/out/anchor-pvm-cpu-release.apk 2026.10.14.1 --target releases-a --target releases-b
# SSH authentication and host keys come from the operator's existing SSH configuration. No default server.
set -euo pipefail
usage() { echo "usage: $0 <apk> <version> --target SSH_HOST [--target SSH_HOST ...] [--directory ABS_PATH]" >&2; exit 2; }
[ "$#" -ge 2 ] || usage
APK=$1; VERSION=$2; shift 2
TARGETS=(); PUBLISH_DIR=/opt/enclave-get/android
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] || usage; TARGETS+=("$2"); shift 2 ;;
    --directory) [ "$#" -ge 2 ] || usage; PUBLISH_DIR=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ "${#TARGETS[@]}" -gt 0 ] || { echo "at least one explicit --target SSH_HOST is required" >&2; exit 2; }
# These values also occur in the remote shell and scp destination. Keep a deliberately narrow grammar;
# use an SSH config alias for IPv6, ports, proxies or other transport options.
for target in "${TARGETS[@]}"; do
  [[ "$target" =~ ^([A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || { echo "invalid SSH target; use a host or SSH config alias" >&2; exit 2; }
done
[[ "$PUBLISH_DIR" =~ ^/([A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || { echo "invalid publishing directory; use an absolute path with simple directory names" >&2; exit 2; }
[[ "$VERSION" =~ ^20[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] || { echo "version is YYYY.MM.DD.N" >&2; exit 2; }
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"; BT="$SDK/build-tools/35.0.0"
TOP=$(git rev-parse --show-toplevel)
# the release key's certificate (the relay pins its authority: PVM_CPU_AUTHORITY_HASHES)
RELEASE_CERT_SHA256=867ebe7da4c41fa5186996ac443dfde14f435d6f1ce9da98681199d86929523d
MANIFEST=$("$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK") || { echo "refused: APK manifest could not be inspected" >&2; exit 2; }
if grep -q 'debuggable(0x0101000f)=true' <<< "$MANIFEST"; then echo "refused: $APK is debuggable (a lab build)" >&2; exit 2; fi
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
for target in "${TARGETS[@]}"; do
  echo "publishing $VERSION to $target:$PUBLISH_DIR"
  ssh -o BatchMode=yes "$target" "mkdir -p '$PUBLISH_DIR'"
  scp -B -q "$T/$FILE" "$T/SHA256SUMS-$VERSION" "$target:$PUBLISH_DIR/"
  ssh -o BatchMode=yes "$target" "cd '$PUBLISH_DIR' && sha256sum -c 'SHA256SUMS-$VERSION' && cp '$FILE' Enclave.apk.tmp && mv Enclave.apk.tmp Enclave.apk"
  scp -B -q "$T/latest.json" "$target:$PUBLISH_DIR/latest.json.tmp"
  ssh -o BatchMode=yes "$target" "cd '$PUBLISH_DIR' && chmod 0644 '$FILE' 'SHA256SUMS-$VERSION' Enclave.apk latest.json.tmp && chmod 0755 . && mv latest.json.tmp latest.json"
done
echo "published the Enclave Android app $VERSION: apk $ASHA, code hash $CODE_HASH"
cat "$T/latest.json"
