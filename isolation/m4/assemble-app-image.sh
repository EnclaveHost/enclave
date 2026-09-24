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
d=$(mktemp -d); s=$(mktemp -d)
trap 'rm -rf "$d" "$s"' EXIT
# built per run from this checkout (Go's build cache makes it quick): a cached binary could predate the contract it
# must read, and concurrent launches would race writing one
BUNDLETOOL=${BUNDLETOOL:-$s/bundletool}
[ -x "$BUNDLETOOL" ] || (cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BUNDLETOOL" ./cmd/bundle)
# ONE read of the bundle: the AppID, the extracted component and the copy in the image all come from this private
# snapshot, so a bundle file replaced while this runs cannot give the image one app's ID and another's bytes.
cp "$bundle" "$s/app.bundle"
app_id=$("$BUNDLETOOL" id "$s/app.bundle")
[ ${#app_id} = 64 ] || { echo "not a contract bundle: $bundle" >&2; exit 1; }
cp -a "$t/." "$d/"
# the artifact is what the runtime executes; the bundle is what the identity is taken over. Both measured.
"$BUNDLETOOL" extract "$s/app.bundle" "$d/app.wasm"
# how the domain runs the app, from the bundle's own manifest: a wasi:cli command names its HTTP port, and the init
# runs it on that port (/app.run); a wasi:http component is served by the runtime and gets no file
mode=$("$BUNDLETOOL" mode "$s/app.bundle")
case "$mode" in
  serve) ;;
  "run "*) printf '%s\n' "${mode#run }" > "$d/app.run" ;;
  *) echo "assemble-app-image.sh: the bundle states no runnable mode ($mode)" >&2; exit 1 ;;
esac
cp "$s/app.bundle" "$d/app.bundle"
printf '%s\n' "$app_id" > "$d/app.sha256"
# modes, ownership and times normalised, so the measurement depends on contents alone (pack-initrd.sh)
"$here/pack-initrd.sh" "$d" "$out"
echo "app_image $out app_id $app_id"
