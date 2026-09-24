#!/bin/sh
# Assemble ONE app's measured initramfs from a template and a contract bundle. The only step that differs per app,
# and the one step build-app-guest.sh and a verifier (expected-measurement.sh) share, so the image a host builds
# and the image a verifier reconstructs from a published release cannot come from two procedures.
#
# The app-specific files are exactly three: app.bundle (what the identity is taken over), app.wasm (the component
# the runtime serves, cut from that bundle by the contract's own extractor) and app.sha256 (the AppID, which the
# front puts in report_data[32:64]). A template that already carries any of them is refused, not overwritten.
#
#   usage: assemble-app-image.sh <template dir> <app.bundle> <out.cpio.gz>
set -e
here=$(cd "$(dirname "$0")" && pwd)
t=${1:?usage: assemble-app-image.sh <template> <bundle> <out>}; bundle=${2:?}; out=${3:?}
for f in app.bundle app.wasm app.sha256; do
  [ ! -e "$t/$f" ] || { echo "assemble-app-image.sh: the template already carries $f" >&2; exit 2; }
done
BUNDLETOOL=${BUNDLETOOL:-$here/.bundle}
[ -x "$BUNDLETOOL" ] || (cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BUNDLETOOL" ./cmd/bundle)
app_id=$("$BUNDLETOOL" id "$bundle")
[ ${#app_id} = 64 ] || { echo "not a contract bundle: $bundle" >&2; exit 1; }
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
cp -a "$t/." "$d/"
# the artifact is what the runtime executes; the bundle is what the identity is taken over. Both measured.
"$BUNDLETOOL" extract "$bundle" "$d/app.wasm"
cp "$bundle" "$d/app.bundle"
printf '%s\n' "$app_id" > "$d/app.sha256"
# modes, ownership and times normalised, so the measurement depends on contents alone (pack-initrd.sh)
"$here/pack-initrd.sh" "$d" "$out"
echo "app_image $out app_id $app_id"
