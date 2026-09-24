#!/bin/sh
# The launch measurement an app's per-app guest must report, reconstructed from a DOMAIN RELEASE and the app's
# bundle - no host binaries involved. This is the verifier's side of M4a: pin the release id, recompute, and then
# judge a live guest against the result (isolation/m2/client.mjs --measurement <this> --app-sha <app_id>
# --runtime <release>/template/rt/runtime.json).
#
# The release is COPIED first and the copy is verified and used, so nothing can change between the check and the
# reconstruction. Its firmware must be one this repository pins as verifying (verifying-firmware.txt): a measured
# hash table over a firmware that does not verify it proves nothing.
#
#   usage: expected-measurement.sh <release dir> <app.bundle> <vcpus> [pinned release id]
#   prints: release <id>, app_id <hex>, runtime_identity <path in the release>, measurement <hex>
set -e
here=$(cd "$(dirname "$0")" && pwd)
rel=${1:?usage: expected-measurement.sh <release> <bundle> <vcpus> [pinned id]}; bundle=${2:?}; vcpus=${3:?}; pin=${4:-}
case "$vcpus" in ''|*[!0-9]*) echo "vcpus must be a number" >&2; exit 2 ;; esac
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cp -a "$rel" "$t/release"
R=$t/release
if [ -n "$pin" ]; then v=$(python3 "$here/release-manifest.py" verify "$R" --expect "$pin")
else v=$(python3 "$here/release-manifest.py" verify "$R"); fi
rid=$(echo "$v" | awk '{print $2}')
fw=$(sha256sum "$R/firmware.fd" | cut -c1-64)
grep -qE "^$fw[[:space:]]" "$here/verifying-firmware.txt" || {
  echo "REFUSED: the release's firmware ($fw) is not pinned as verifying" >&2; exit 1; }
field() { python3 "$here/release-manifest.py" field "$R" "$1"; }
a=$("$here/assemble-app-image.sh" "$R/template" "$bundle" "$t/image.cpio.gz")
m=$(~/.local/bin/sev-snp-measure --mode "$(field measure.mode)" --vcpus "$vcpus" --vcpu-family "$(field measure.vcpuFamily)" \
  --vcpu-model "$(field measure.vcpuModel)" --vcpu-stepping "$(field measure.vcpuStepping)" \
  --vmm-type "$(field measure.vmmType)" --ovmf "$R/firmware.fd" --kernel "$R/kernel" --initrd "$t/image.cpio.gz" \
  --append "$(field cmdline)" | tr A-F a-f)
[ ${#m} = 96 ] || { echo "REFUSED: no measurement computed" >&2; exit 1; }
echo "release $rid"
echo "app_id $(echo "$a" | awk '{print $4}')"
echo "runtime_identity $rel/template/rt/runtime.json"
echo "measurement $m"
