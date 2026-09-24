#!/bin/sh
# Build an M4b PLANE domain: a domain that admits its artifacts to the measured SVSM and then serves TLS.
#
# HOW IT DIFFERS FROM THE OTHER TWO GUESTS. build-app-guest.sh makes a serving domain whose app is in the LAUNCH
# measurement (M4a, one guest per app); build-admit-guest.sh makes a guest that only exercises admission and
# prints results. This makes a SERVING domain whose app identity comes from the SVSM's compiled tables instead of
# from its own image - which is what the IGVM path needs, because there the guest image is outside the launch
# measurement and anything the image asserted about the app would be asserted by unmeasured code.
#
# So this image carries the artifacts to be ADMITTED (the bundle, the runtime ELF) and the front, and its init
# refuses to serve if the SVSM refuses either artifact. The digests the SVSM must have been built to expect are
# printed at the end: they go into ENCLAVE_APP_IDS and ENCLAVE_RUNTIME_SHA256, so a mismatch is a build error
# rather than a mystery at runtime.
#
#   usage: build-plane-guest.sh <app.bundle> <out.cpio.gz>
set -e
here=$(cd "$(dirname "$0")" && pwd)
m2=$here/../m2
bundle=$1; out=$2
[ -f "$bundle" ] && [ -n "$out" ] || { echo "usage: build-plane-guest.sh <app.bundle> <out.cpio.gz>"; exit 2; }

BUNDLETOOL=${BUNDLETOOL:-$here/.bundle}
[ -x "$BUNDLETOOL" ] || (cd "$here/../contract" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$BUNDLETOOL" ./cmd/bundle)
app_id=$("$BUNDLETOOL" id "$bundle")
[ ${#app_id} = 64 ] || { echo "bundle id did not give 32 bytes of hex: $app_id"; exit 1; }

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
gcc -static -O2 -o "$d/init" "$here/guest/planeinit.c"
(cd "$m2" && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$d/front" ./front)
# the module is built against the GUEST kernel; one for the wrong release will not load
(cd "$here/guest" && make >/dev/null)
cp "$here/guest/appidmod.ko" "$d/appidmod.ko"
mkdir -p "$d/rt" "$d/proc" "$d/sys" "$d/dev" "$d/tmp"
W=$(command -v wasmtime)
cp -L "$W" "$d/rt/wasmtime"
"$here/../contract/runtime-identity.sh" "$W" > "$d/rt/runtime.json"
ldd "$W" | awk '/=>/ {print $3}' | while read -r lib; do cp -L "$lib" "$d/rt/"; done
cp -L /lib64/ld-linux-x86-64.so.2 "$d/rt/" 2>/dev/null || cp -L /lib/ld-linux-x86-64.so.2 "$d/rt/"
# the bundle is what the SVSM admits; the extracted component is what the runtime executes
"$BUNDLETOOL" extract "$bundle" "$d/app.wasm"
cp "$bundle" "$d/app.bundle"
printf '%s\n' "$app_id" > "$d/app.sha256"
. "$here/../m1/domain.env"
M=/lib/modules/$GUEST_KREL/kernel
# NO report interface. This plane holds no VMPCK, so sev-guest could not serve a report even if present, and
# the SVSM is the only path to one - which is the property, not an omission.
cp "$M/net/vmw_vsock/vsock.ko.zst" "$M/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
   "$M/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" "$d/"
find "$d" -exec touch -h -d @0 {} +
(cd "$d" && find . -mindepth 1 | LC_ALL=C sort | cpio -o -H newc --reproducible 2>/dev/null | gzip -n -9) > "$out"

rt_sha=$(sha256sum "$d/rt/wasmtime" | cut -c1-64)
# RuntimeID comes from the CONTRACT's own implementation (runtime.mjs runtimeId), never recomputed here: it is
# sha256 of a canonical JSON encoding, and a second implementation of that canonicalisation is a second thing to
# get wrong. The SVSM must be built with this value, so a wrong one here would produce a binding no verifier
# could reproduce.
rid=$(node -e '
import("'"$here"'/../contract/runtime.mjs").then(m => {
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(m.runtimeId(r).toString("hex"));
}).catch(e => { process.stderr.write(String(e)); process.exit(1); });
' "$d/rt/runtime.json")
[ ${#rid} = 64 ] || { echo "the contract did not give a 32-byte RuntimeID for $d/rt/runtime.json" >&2; exit 1; }
echo "plane_guest $out ($(stat -c %s "$out") bytes)"
echo "  bundle  app id  $app_id   <- ENCLAVE_APP_IDS entry for this plane"
echo "  runtime sha256  $rt_sha   <- ENCLAVE_RUNTIME_SHA256 entry"
echo "  runtime id      $rid   <- ENCLAVE_RUNTIME_IDS entry"
echo "  NOTE: the wasmtime ELF only; its interpreter and shared libraries are NOT admitted"
