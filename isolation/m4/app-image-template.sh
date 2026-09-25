#!/bin/sh
# The M4a image TEMPLATE: everything in a per-app guest's measured initramfs EXCEPT the app - the init, the front,
# the runtime set (runtime-set.sh, the same composition the plane admits), the guest modules and the empty mount
# points. assemble-app-image.sh adds one app to it; build-app-guest.sh does both; domain-release.sh publishes the
# template so a verifier can reassemble the same image from pinned files instead of from this host's binaries.
#
#   usage: app-image-template.sh <dir>     (dir must not exist or be empty)
set -e
here=$(cd "$(dirname "$0")" && pwd)
m2=$here/../m2
t=${1:?usage: app-image-template.sh <dir>}
if [ -e "$t" ] && [ -n "$(ls -A "$t")" ]; then echo "app-image-template.sh: $t is not empty" >&2; exit 2; fi
mkdir -p "$t"
gcc -static -O2 -o "$t/init" "$m2/dominit.c"
# static and byte-reproducible for a given Go toolchain, so the measurement is predictable. GOFLAGS is CLEARED: a caller's
# environment must never decide what the measured front is (a lab's -tags releaselab reaching a production guestd would
# build lab fronts; enclave-99). A LAB front is asked for by name, ISOLATION_LAB_FRONT=1, and only builds with the lab
# pins present (m2/release/labpins/, written by m2/lab-release/run-lab.sh).
tags=""
if [ "${ISOLATION_LAB_FRONT:-}" = 1 ]; then
  [ -f "$m2/release/labpins/ca.pem" ] && [ -f "$m2/release/labpins/release-key.hex" ] || {
    echo "app-image-template.sh: ISOLATION_LAB_FRONT=1 without lab pins in $m2/release/labpins" >&2; exit 2; }
  tags="-tags=releaselab"
  echo "app-image-template.sh: building a LAB front (lab relay, lab CA, lab release key): not a production image" >&2
fi
(cd "$m2" && GOFLAGS= CGO_ENABLED=0 go build $tags -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$t/front" ./front)
mkdir -p "$t/proc" "$t/sys" "$t/dev" "$t/tmp"
"$here/runtime-set.sh" compose "$t/rt"
# The guest kernel's module tree is named after the GUEST kernel, not the host's: see ../m1/domain.env.
. "$here/../m1/domain.env"
M=/lib/modules/$GUEST_KREL/kernel
cp "$M/net/vmw_vsock/vsock.ko.zst" "$M/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
   "$M/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
   "$M/drivers/virt/coco/guest/tsm_report.ko.zst" "$M/drivers/virt/coco/sev-guest/sev-guest.ko.zst" "$t/"
