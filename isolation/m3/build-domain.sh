#!/bin/sh
# Build the M3 MONITOR image: a reproducible initramfs holding PID 1 (dominit.c), the monitor, and the
# read-only platform tree every domain gets (the runtime, the front, and domexec).
#
# The difference from M1 and M2 is what is NOT in here: no app. Apps arrive at lease start over the
# control channel, so this image's launch measurement is the same whatever runs on it, and the app's
# identity comes from the monitor instead (isolation/m3/PLAN.md section 3). test-m3.sh check 2 proves
# exactly that.
#
# usage: build-domain.sh <out.cpio.gz> [vcpus=1]
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=$1; vcpus=${2:-1}
[ -n "$out" ] || { echo "usage: build-domain.sh <out.cpio.gz> [vcpus]"; exit 2; }
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
gcc -static -O2 -o "$d/init" "$here/dominit.c"
mkdir -p "$d/plat/rt" "$d/domains" "$d/run" "$d/proc" "$d/sys" "$d/dev" "$d/tmp"
gcc -static -O2 -o "$d/plat/domexec" "$here/domexec.c"
# the adversary probe: measured, so it is auditable, and selectable only BETWEEN measured binaries
gcc -static -O2 -o "$d/plat/domprobe" "$here/domprobe.c"
# static and byte-reproducible for a given Go toolchain; the front is the same binary M2 uses
(cd "$here" && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$d/monitor" ./monitor)
(cd "$here/../m2" && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$d/plat/front" ./front)
W=$(command -v wasmtime)
cp -L "$W" "$d/plat/rt/wasmtime"
ldd "$W" | awk '/=>/ {print $3}' | while read -r lib; do cp -L "$lib" "$d/plat/rt/"; done
M=/lib/modules/$(uname -r)/kernel
cp "$M/net/vmw_vsock/vsock.ko.zst" "$M/net/vmw_vsock/vmw_vsock_virtio_transport_common.ko.zst" \
   "$M/net/vmw_vsock/vmw_vsock_virtio_transport.ko.zst" \
   "$M/drivers/virt/coco/guest/tsm_report.ko.zst" "$M/drivers/virt/coco/sev-guest/sev-guest.ko.zst" "$d/"
find "$d" -exec touch -h -d @0 {} +
(cd "$d" && find . -mindepth 1 | LC_ALL=C sort | cpio -o -H newc --reproducible 2>/dev/null | gzip -n -9) > "$out"
echo "monitor image $out: $(stat -c %s "$out") bytes, no app inside"
echo "monitor sha256 $(sha256sum "$d/monitor" | cut -c1-64) ($(go version | cut -d' ' -f3))"

# The launch digest this guest will have (run-domain.sh uses the same kernel, command line, firmware
# and vCPU signature). vCPU count is part of the identity; the apps loaded into it are not.
. "$here/../m1/domain.env"
~/.local/bin/sev-snp-measure --mode snp --vcpus "$vcpus" --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 \
  --vmm-type QEMU --ovmf "$OVMF" --kernel "$KERNEL" --initrd "$out" --append "$APPEND" \
  | sed 's/^/predicted measurement: /'
