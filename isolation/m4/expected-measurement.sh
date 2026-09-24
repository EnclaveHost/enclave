#!/bin/sh
# The launch measurement an app's per-app guest must report, reconstructed from a DOMAIN RELEASE and the app's
# bundle - no host binaries involved. The verifier's side of M4a.
#
#   ACCEPTANCE   expected-measurement.sh --pin <release id> <release dir> <app.bundle> <vcpus> [--runtime-out FILE]
#                prints: release <id>, app_id <hex>, runtime_id <hex>, runtime_identity_json <json>, measurement <hex>
#                Then judge a live guest against exactly these: isolation/m2/client.mjs --measurement <measurement>
#                --app-sha <app_id> --runtime FILE (the runtime identity WRITTEN from the verified snapshot).
#   INSPECTION   expected-measurement.sh --inspect <release dir> <app.bundle> <vcpus>
#                the same reconstruction against an UNPINNED release; every line is prefixed "INSPECTION-ONLY" and
#                the measurement line is "unpinned_measurement", so nothing that reads acceptance output can take it.
#
# WHY A PIN IS REQUIRED FOR ACCEPTANCE. Without one, verification shows only that a release agrees with its own
# manifest - self-consistency, which a manifest rewritten to match a tampered file also has. The pin is the
# verifier's trusted statement of WHICH release; there is no acceptance without it.
#
# ONE SNAPSHOT. The release and the bundle are each copied once into a private directory before anything is read,
# and every later step - the manifest check, the firmware check, the AppID, the image, the runtime identity - reads
# only the copies. The runtime identity is printed and written FROM the snapshot, never as a path back into the
# caller's release, which could change after it was verified.
#
# EM_TEST_AFTER_SNAPSHOT, if set, is run by sh after the snapshot and before anything reads it. It exists for
# test-domain-release.sh to change the ORIGINALS at exactly that moment; it has no other use.
set -e
here=$(cd "$(dirname "$0")" && pwd)
usage() { sed -n '4,11p' "$0" >&2; exit 2; }
mode=; pin=; rtout=
case "${1:-}" in
  --pin) [ $# -ge 5 ] || usage; pin=$2; rel=$3; bundle=$4; vcpus=$5; mode=accept; shift 5
         if [ $# -gt 0 ]; then [ "$1" = --runtime-out ] && [ $# = 2 ] || usage; rtout=$2; fi ;;
  --inspect) [ $# = 4 ] || usage; rel=$2; bundle=$3; vcpus=$4; mode=inspect ;;
  *) echo "REFUSED: acceptance needs an explicit pinned release id (--pin <id>); --inspect is inspection only" >&2
     usage ;;
esac
case "$vcpus" in ''|*[!0-9]*) echo "vcpus must be a number" >&2; exit 2 ;; esac
if [ "$mode" = accept ]; then
  echo "$pin" | grep -qE '^[0-9a-f]{64}$' || { echo "REFUSED: the pin must be a 64-hex release id" >&2; exit 2; }
fi
[ -d "$rel" ] && [ -f "$bundle" ] || { echo "REFUSED: no release directory or no bundle file" >&2; exit 2; }
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cp -a "$rel" "$t/release"
cp "$bundle" "$t/app.bundle"
[ -z "${EM_TEST_AFTER_SNAPSHOT:-}" ] || sh -c "$EM_TEST_AFTER_SNAPSHOT"
R=$t/release
M="python3 $here/release-manifest.py"
if [ "$mode" = accept ]; then v=$($M verify "$R" --expect "$pin"); PIN="--expect $pin"
else v=$($M verify "$R"); PIN=""; fi
rid=$(echo "$v" | awk '{print $2}')
fw=$(sha256sum "$R/firmware.fd" | cut -c1-64)
grep -qE "^$fw[[:space:]]" "$here/verifying-firmware.txt" || {
  echo "REFUSED: the release's firmware ($fw) is not pinned as verifying" >&2; exit 1; }
# shellcheck disable=SC2086
field() { $M field "$R" "$1" $PIN; }
a=$("$here/assemble-app-image.sh" "$R/template" "$t/app.bundle" "$t/image.cpio.gz")
m=$(~/.local/bin/sev-snp-measure --mode "$(field measure.mode)" --vcpus "$vcpus" --vcpu-family "$(field measure.vcpuFamily)" \
  --vcpu-model "$(field measure.vcpuModel)" --vcpu-stepping "$(field measure.vcpuStepping)" \
  --vmm-type "$(field measure.vmmType)" --ovmf "$R/firmware.fd" --kernel "$R/kernel" --initrd "$t/image.cpio.gz" \
  --append "$(field cmdline)" | tr A-F a-f)
[ ${#m} = 96 ] || { echo "REFUSED: no measurement computed" >&2; exit 1; }
# The runtime identity the guest must state, from the VERIFIED snapshot: its RuntimeID by the contract's own
# function, and the document itself.
rtj=$R/template/rt/runtime.json
rid_rt=$(node -e 'import("'"$here"'/../contract/runtime.mjs").then(m=>process.stdout.write(m.runtimeId(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).toString("hex")))' "$rtj")
[ ${#rid_rt} = 64 ] || { echo "REFUSED: the release's runtime identity does not compute" >&2; exit 1; }
if [ "$mode" = accept ]; then
  [ -z "$rtout" ] || cp "$rtj" "$rtout"
  echo "release $rid"
  echo "app_id $(echo "$a" | awk '{print $4}')"
  echo "runtime_id $rid_rt"
  echo "runtime_identity_json $(tr -d '\n' < "$rtj")"
  echo "measurement $m"
else
  echo "INSPECTION-ONLY release $rid (NOT pinned: self-consistent only, not a trusted release)"
  echo "INSPECTION-ONLY app_id $(echo "$a" | awk '{print $4}')"
  echo "INSPECTION-ONLY runtime_id $rid_rt"
  echo "INSPECTION-ONLY unpinned_measurement $m"
fi
