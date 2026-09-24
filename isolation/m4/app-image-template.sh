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
# static and byte-reproducible for a given Go toolchain, so the measurement is predictable
(cd "$m2" && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$t/front" ./front)
mkdir -p "$t/proc" "$t/sys" "$t/dev" "$t/tmp"
"$here/runtime-set.sh" compose "$t/rt"
# The guest kernel's module tree is named after the GUEST kernel, not the host's: see ../m1/domain.env.
. "$here/../m1/domain.env"
M=/lib/modules/$GUEST_KREL/kernel
cp "$M/net/vmw_vsock/vsock.ko.zst" "$M/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
   "$M/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
   "$M/drivers/virt/coco/guest/tsm_report.ko.zst" "$M/drivers/virt/coco/sev-guest/sev-guest.ko.zst" "$t/"
